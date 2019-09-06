let chalk = require('chalk')
let glob = require('glob')
let series = require('run-series')
let fs = require('fs')
let path = require('path')
let print = require('./_printer')
let child = require('child_process')
let shared = require('./shared')
let {inventory, updater} = require('@architect/utils')

/**
  installs deps into
  - functions
  - src/shared
  - src/views
*/
module.exports = function install(params={}, callback) {
  let {basepath, env, quiet, shell, timeout, verbose} = params
  basepath = basepath || 'src'

  /**
   * Find our dependency manifests
   */
  // eslint-disable-next-line
  let pattern = p => `${p}/**/@(package\.json|requirements\.txt|Gemfile)`
  // Always hydrate src/shared + src/views
  let sharedFiles = glob.sync(pattern(process.cwd())).filter(function filter(filePath) {
    if (filePath.includes('node_modules') ||
        filePath.includes('vendor/bundle'))
      return false
    if (filePath.includes('src/shared') ||
        filePath.includes('src/views'))
      return true
  })
  // Get everything else
  let files = glob.sync(pattern(basepath)).filter(function filter(filePath) {
    if (filePath.includes('node_modules') ||
        filePath.includes('vendor/bundle') ||
        filePath.includes('src/shared') ||
        filePath.includes('src/views'))
      return false
    return true
  })
  files = files.concat(sharedFiles)

  /**
   * Normalize paths
   */
  // Windows
  if (process.platform.startsWith('win')) {
    files = files.map(file => file.replace(/\//gi, '\\'))
  }
  // Ensure all paths are relative; previous glob ops may be from absolute paths, producing absolute-pathed results
  files = files.map(file => {
    // Normalize to relative paths
    file = file.replace(process.cwd(),'')
    return file[0] === path.sep ? file.substr(1) : file // jiccya
  })

  /**
   * Filter by active project paths (and root, if applicable)
   */
  let inv = inventory()
  files = files.filter(file => {
    // Allow root project hydration of process.cwd() if passed as basepath
    let hydrateBasepath = basepath === process.cwd()
    if (hydrateBasepath && path.dirname(file) === '.')
      return true

    // Allow src/shared and src/views
    let isShared = path.join('src', 'shared')
    let isViews = path.join('src', 'views')
    if (file.startsWith(isShared) || file.startsWith(isViews))
      return true

    // Hydrate functions, of course
    return inv.localPaths.some(p => p === path.dirname(file))
  })

  /**
   * Build out job queue
   */
  let deps = files.length
  let update = updater('Hydrate')
  let p = basepath.substr(-1) === '/' ? `${basepath}/` : basepath
  if (deps && deps > 0)
    update.status(`Hydrating dependencies in ${deps} path${deps > 1 ? 's' : ''}`)
  if (!deps && verbose)
    update.status(`No dependencies found in: ${p}${path.sep}**`)

  let ops = files.map(file=> {
    let cwd = path.dirname(file)
    let options = {cwd, env, shell, timeout}
    return function hydration(callback) {
      let start
      let cmd
      let now = Date.now()

      // Prints and executes the command
      function exec(command, opts, callback) {
        cmd = command
        let action = 'Hydrating'
        start = print.start({cwd, action, quiet, verbose})
        child.exec(cmd, opts, callback)
      }

      // Prints the result
      function done(err, stdout, stderr) {
        // If zero output, acknowledge *something* happened
        if (!err && !stdout && !stderr) stdout = `done in ${(Date.now() - now) / 1000}s`
        print.done({err, stdout, stderr, cmd, start, quiet, verbose}, callback)
      }

      // TODO: I think we should consider what minimum version of node/npm this
      // module needs to use as the npm commands below have different behaviour
      // depending on npm version - and enshrine those in the package.json
      if (file.includes('package.json')) {
        if (fs.existsSync(path.join(cwd, 'package-lock.json'))) {
          exec(`npm ci`, options, done)
        }
        else {
          exec(`npm i`, options, done)
        }
      }

      if (file.includes('requirements.txt'))
        exec(`pip3 install -r requirements.txt -t ./vendor`, options, done)

      if (file.includes('Gemfile'))
        exec(`bundle install --path vendor/bundle`, options, done)
    }
  })

  // Always run shared hydration
  ops.push(shared)

  series(ops, (err, result) => {
    if (err) callback(err)
    else {
      if (deps && deps > 0)
        update.done('Success!', chalk.green('Finished hydrating dependencies'))
      if (!deps)
        update.done('Finished checks, nothing to hydrate')

      callback(null, result)
    }
  })
}
