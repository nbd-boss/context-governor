// Local Windows startup workaround for tsx.
//
// On this host, os.userInfo() intermittently fails with uv_os_get_passwd
// ENOMEM before DSH or any plugin is loaded. tsx only needs a stable name to
// form its temporary pipe directory, so preserve normal behavior and supply a
// local fallback only for that startup-time failure.
const os = require('node:os')
const { syncBuiltinESMExports } = require('node:module')

const originalUserInfo = os.userInfo

os.userInfo = (...args) => {
  try {
    return originalUserInfo(...args)
  } catch (error) {
    if (error?.code !== 'ERR_SYSTEM_ERROR') throw error
    return { username: 'dsh-local' }
  }
}

syncBuiltinESMExports()
