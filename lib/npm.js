// NPM 核心模块，生成并导出 npm 实例

// The order of the code in this file is relevant, because a lot of things
// require('npm.js'), but also we need to use some of those modules.  So,
// we define and instantiate the singleton ahead of loading any modules
// required for its methods.

// these are all dependencies used in the ctor
const EventEmitter = require('events')
const { resolve, dirname } = require('path')
const Config = require('@npmcli/config')

// Patch the global fs module here at the app level
require('graceful-fs').gracefulify(require('fs'))

const procLogListener = require('./utils/proc-log-listener.js')

const hasOwnProperty = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key)

// the first time `npm.commands.xyz` is loaded, it gets added
// to the cmds object, so we don't have to load it again.
// 通过 Proxy 代理执行命令脚本。并将执行过的命令函数缓存到 cmd 中
const proxyCmds = (npm) => {
  const cmds = {}
  return new Proxy(cmds, {
    get: (prop, cmd) => {
      if (hasOwnProperty(cmds, cmd))
        return cmds[cmd]

      // 解析缩写命令。如：i -> install
      const actual = deref(cmd)
      if (!actual) {
        cmds[cmd] = undefined
        return cmds[cmd]
      }
      if (cmds[actual]) {
        cmds[cmd] = cmds[actual]
        return cmds[cmd]
      }
      // mackCmd 生成真正的执行函数
      cmds[actual] = makeCmd(actual)
      cmds[cmd] = cmds[actual]
      return cmds[cmd]
    },
  })
}

// 生成命令执行函数。主要是二次封装 ${cmd}.js 的方法。所以说真正执行的命令是 ${cmd}.js 文件
const makeCmd = cmd => {
  const impl = require(`./${cmd}.js`)
  const fn = (args, cb) => npm[_runCmd](cmd, impl, args, cb)
  Object.assign(fn, impl)
  return fn
}

const { types, defaults, shorthands } = require('./utils/config.js')

let warnedNonDashArg = false
const _runCmd = Symbol('_runCmd')
const _load = Symbol('_load')
const _flatOptions = Symbol('_flatOptions')
const _tmpFolder = Symbol('_tmpFolder')
const _title = Symbol('_title')

// npm 实例
const npm = module.exports = new class extends EventEmitter {
  constructor () {
    super()
    require('./utils/perf.js')
    this.modes = {
      exec: 0o755,
      file: 0o644,
      umask: 0o22,
    }
    this.started = Date.now()
    this.command = null
    // 重点1: 代理所有 cmd
    this.commands = proxyCmds(this)
    procLogListener()
    process.emit('time', 'npm')
    this.version = require('../package.json').version
    // 重点2: 获取执行过程所需的配置信息 config
    this.config = new Config({
      npmPath: dirname(__dirname),
      types,
      defaults,
      shorthands,
    })
    this[_title] = process.title
    this.updateNotification = null
  }

  deref (c) {
    return deref(c)
  }

  // this will only ever be called with cmd set to the canonical command name
  /**
   * @description 指令命令的包装函数
   * @param {String} cmd 命令字符串
   * @param {Function} impl ${cmd}.js 文件导出的命令函数，并带有附加属性，如 { usage, completion }
   * @param {Object} args 参数
   * @param {Function} cb 回调函数
   */
  [_runCmd] (cmd, impl, args, cb) {
    if (!this.loaded) {
      throw new Error(
        'Call npm.load(cb) before using this command.\n' +
        'See the README.md or bin/npm-cli.js for example usage.'
      )
    }

    process.emit('time', `command:${cmd}`)
    // since 'test', 'start', 'stop', etc. commands re-enter this function
    // to call the run-script command, we need to only set it one time.
    if (!this.command) {
      process.env.npm_command = cmd
      this.command = cmd
    }

    // Options are prefixed by a hyphen-minus (-, \u2d).
    // Other dash-type chars look similar but are invalid.
    if (!warnedNonDashArg) {
      args.filter(arg => /^[\u2010-\u2015\u2212\uFE58\uFE63\uFF0D]/.test(arg))
        .forEach(arg => {
          warnedNonDashArg = true
          log.error('arg', 'Argument starts with non-ascii dash, this is probably invalid:', arg)
        })
    }

    // 如果有 --usage(-h) 参数，则打印命令的使用教程
    // 否则 执行命令原始函数
    if (this.config.get('usage')) {
      console.log(impl.usage)
      cb()
    } else {
      impl(args, er => {
        process.emit('timeEnd', `command:${cmd}`)
        cb(er)
      })
    }
  }

  // call with parsed CLI options and a callback when done loading
  // XXX promisify this and stop taking a callback
  // npm 实例加载 初始化
  load (cb) {
    if (!cb || typeof cb !== 'function')
      throw new TypeError('must call as: npm.load(callback)')

    this.once('load', cb)
    if (this.loaded || this.loadErr) {
      this.emit('load', this.loadErr)
      return
    }
    if (this.loading)
      return

    this.loading = true

    process.emit('time', 'npm:load')
    this.log.pause()
    return this[_load]().catch(er => er).then((er) => {
      this.loading = false
      this.loadErr = er
      if (!er && this.config.get('force'))
        this.log.warn('using --force', 'Recommended protections disabled.')

      if (!er && !this[_flatOptions])
        this[_flatOptions] = require('./utils/flat-options.js')(this)

      process.emit('timeEnd', 'npm:load')
      this.emit('load', er)
    })
  }

  get loaded () {
    return this.config.loaded
  }

  get title () {
    return this[_title]
  }

  set title (t) {
    process.title = t
    this[_title] = t
  }

  // npm 实例加载 初始化 - 内部方法
  async [_load] () {
    // 获取 node 执行文件的路径
    const node = await which(process.argv[0]).catch(er => null)
    if (node && node.toUpperCase() !== process.execPath.toUpperCase()) {
      log.verbose('node symlink', node)
      process.execPath = node
    }
    this.config.execPath = node

    // 这里才真正解析 config 数据
    await this.config.load()
    // 拿到不参与解析的 cli 参数(nopt 解析得到的 argv.remain 数据)
    // 这个其实就是真正要执行的命令 (如：npm i vue -g，得到 ["i", "vue"]，-g 已被解析为参数)
    this.argv = this.config.parsedArgv.remain
    // note: this MUST be shorter than the actual argv length, because it
    // uses the same memory, so node will truncate it if it's too long.
    // if it's a token revocation, then the argv contains a secret, so
    // don't show that.  (Regrettable historical choice to put it there.)
    // Any other secrets are configs only, so showing only the positional
    // args keeps those from being leaked.
    const tokrev = deref(this.argv[0]) === 'token' && this.argv[1] === 'revoke'
    this.title = tokrev ? 'npm token revoke' + (this.argv[2] ? ' ***' : '')
      : ['npm', ...this.argv].join(' ')

    this.color = setupLog(this.config, this)
    process.env.COLOR = this.color ? '1' : '0'

    cleanUpLogFiles(this.cache, this.config.get('logs-max'), log.warn)

    log.resume()
    const umask = this.config.get('umask')
    this.modes = {
      exec: 0o777 & (~umask),
      file: 0o666 & (~umask),
      umask,
    }

    const configScope = this.config.get('scope')
    if (configScope && !/^@/.test(configScope))
      this.config.set('scope', `@${configScope}`, this.config.find('scope'))

    this.projectScope = this.config.get('scope') ||
      getProjectScope(this.prefix)

    startMetrics()
  }

  get flatOptions () {
    return this[_flatOptions]
  }

  get lockfileVersion () {
    return 2
  }

  get log () {
    return log
  }

  get cache () {
    return this.config.get('cache')
  }

  set cache (r) {
    this.config.set('cache', r)
  }

  get globalPrefix () {
    return this.config.globalPrefix
  }

  set globalPrefix (r) {
    this.config.globalPrefix = r
  }

  get localPrefix () {
    return this.config.localPrefix
  }

  set localPrefix (r) {
    this.config.localPrefix = r
  }

  get globalDir () {
    return process.platform !== 'win32'
      ? resolve(this.globalPrefix, 'lib', 'node_modules')
      : resolve(this.globalPrefix, 'node_modules')
  }

  get localDir () {
    return resolve(this.localPrefix, 'node_modules')
  }

  get dir () {
    return (this.config.get('global')) ? this.globalDir : this.localDir
  }

  get globalBin () {
    const b = this.globalPrefix
    return process.platform !== 'win32' ? resolve(b, 'bin') : b
  }

  get localBin () {
    return resolve(this.dir, '.bin')
  }

  get bin () {
    return this.config.get('global') ? this.globalBin : this.localBin
  }

  get prefix () {
    return this.config.get('global') ? this.globalPrefix : this.localPrefix
  }

  set prefix (r) {
    const k = this.config.get('global') ? 'globalPrefix' : 'localPrefix'
    this[k] = r
  }

  // XXX add logging to see if we actually use this
  get tmp () {
    if (!this[_tmpFolder]) {
      const rand = require('crypto').randomBytes(4).toString('hex')
      this[_tmpFolder] = `npm-${process.pid}-${rand}`
    }
    return resolve(this.config.get('tmp'), this[_tmpFolder])
  }
}()

// now load everything required by the class methods

const log = require('npmlog')
const { promisify } = require('util')
const startMetrics = require('./utils/metrics.js').start

const which = promisify(require('which'))

const deref = require('./utils/deref-command.js')
const setupLog = require('./utils/setup-log.js')
const cleanUpLogFiles = require('./utils/cleanup-log-files.js')
const getProjectScope = require('./utils/get-project-scope.js')

if (require.main === module)
  require('./cli.js')(process)
