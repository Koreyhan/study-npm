// NPM 核心入口，主要工作：
// 1. 检查 nodejs 版本，做一些兼容性提示
// 2. 加载核心模块 lib/npm.js 获取 npm 实例
// 3. 进行 npm.load，load 之后根据根据 process.argv 中解析得到具体 cmd 执行对应逻辑

// Separated out for easier unit testing
module.exports = (process) => {
  // set it here so that regardless of what happens later, we don't
  // leak any private CLI configs to other programs
  process.title = 'npm'

  const {
    checkForBrokenNode,
    checkForUnsupportedNode,
  } = require('../lib/utils/unsupported.js')

  checkForBrokenNode()

  const log = require('npmlog')
  // 打开日志监听并打印
  // log.on('log', (e) => {
  //   console.log('log:', e)
  // })
  // pause it here so it can unpause when we've loaded the configs
  // and know what loglevel we should be printing.
  log.pause()

  checkForUnsupportedNode()

  // npm 核心实例
  const npm = require('../lib/npm.js')
  const errorHandler = require('../lib/utils/error-handler.js')

  // if npm is called as "npmg" or "npm_g", then
  // run in global mode.
  if (process.argv[1][process.argv[1].length - 1] === 'g')
    process.argv.splice(1, 1, 'npm', '-g')

  log.verbose('cli', process.argv)

  log.info('using', 'npm@%s', npm.version)
  log.info('using', 'node@%s', process.version)

  process.on('uncaughtException', errorHandler)
  process.on('unhandledRejection', errorHandler)

  // now actually fire up npm and run the command.
  // this is how to use npm programmatically:
  const updateNotifier = require('../lib/utils/update-notifier.js')
  // npm 核心实例加载，主要是加载各层级的参数，在回调中执行命令
  npm.load(async er => {
    if (er)
      return errorHandler(er)
    if (npm.config.get('version', 'cli')) {
      console.log(npm.version)
      return errorHandler.exit(0)
    }

    if (npm.config.get('versions', 'cli')) {
      npm.argv = ['version']
      npm.config.set('usage', false, 'cli')
    }

    npm.updateNotification = await updateNotifier(npm)

    // 拿到当前执行命令的名称
    const cmd = npm.argv.shift()
    const impl = npm.commands[cmd]
    if (impl)
      // 执行命令
      impl(npm.argv, errorHandler)
    else {
      npm.config.set('usage', false)
      npm.argv.unshift(cmd)
      npm.commands.help(npm.argv, errorHandler)
    }
  })
}
