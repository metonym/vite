import path from 'path'
import fs from 'fs'
import sirv, { Options } from 'sirv'
import { Connect } from 'types/connect'
import { normalizePath, ViteDevServer } from '../..'
import { FS_PREFIX } from '../../constants'
import {
  cleanUrl,
  ensureLeadingSlash,
  fsPathFromId,
  isImportRequest,
  isInternalRequest,
  isWindows,
  slash
} from '../../utils'

const sirvOptions: Options = {
  dev: true,
  etag: true,
  extensions: [],
  setHeaders(res, pathname) {
    // Matches js, jsx, ts, tsx.
    // The reason this is done, is that the .ts file extension is reserved
    // for the MIME type video/mp2t. In almost all cases, we can expect
    // these files to be TypeScript files, and for Vite to serve them with
    // this Content-Type.
    if (/\.[tj]sx?$/.test(pathname)) {
      res.setHeader('Content-Type', 'application/javascript')
    }
  }
}

export function servePublicMiddleware(dir: string): Connect.NextHandleFunction {
  const serve = sirv(dir, sirvOptions)

  // Keep the named function. The name is visible in debug logs via `DEBUG=connect:dispatcher ...`
  return function viteServePublicMiddleware(req, res, next) {
    // skip import request and internal requests `/@fs/ /@vite-client` etc...
    if (isImportRequest(req.url!) || isInternalRequest(req.url!)) {
      return next()
    }
    serve(req, res, next)
  }
}

export function serveStaticMiddleware(
  dir: string,
  server: ViteDevServer
): Connect.NextHandleFunction {
  const serve = sirv(dir, sirvOptions)

  // Keep the named function. The name is visible in debug logs via `DEBUG=connect:dispatcher ...`
  return function viteServeStaticMiddleware(req, res, next) {
    // only serve the file if it's not an html request or ends with /
    // so that html requests can fallthrough to our html middleware for
    // special processing
    // also skip internal requests `/@fs/ /@vite-client` etc...
    if (
      req.url!.endsWith('/') ||
      path.extname(cleanUrl(req.url!)) === '.html' ||
      isInternalRequest(req.url!)
    ) {
      return next()
    }

    const url = decodeURI(req.url!)

    // apply aliases to static requests as well
    let redirected: string | undefined
    for (const { find, replacement } of server.config.resolve.alias) {
      const matches =
        typeof find === 'string' ? url.startsWith(find) : find.test(url)
      if (matches) {
        redirected = url.replace(find, replacement)
        break
      }
    }
    if (redirected) {
      // dir is pre-normalized to posix style
      if (redirected.startsWith(dir)) {
        redirected = redirected.slice(dir.length)
      }
    }

    const resolvedUrl = redirected || url
    let fileUrl = path.resolve(dir, resolvedUrl.replace(/^\//, ''))
    if (resolvedUrl.endsWith('/') && !fileUrl.endsWith('/')) {
      fileUrl = fileUrl + '/'
    }
    // If the file exist but is restricted, ignore this request
    // This will generate a 403 if it isn't handled by other middlewares
    // We avoid a hard 404 here to avoid leaking file names information
    if (isFileServingRestricted(fileUrl, server)) {
      return next()
    }

    if (redirected) {
      req.url = redirected
    }

    serve(req, res, next)
  }
}

export function serveRawFsMiddleware(
  server: ViteDevServer
): Connect.NextHandleFunction {
  const serveFromRoot = sirv('/', sirvOptions)

  // Keep the named function. The name is visible in debug logs via `DEBUG=connect:dispatcher ...`
  return function viteServeRawFsMiddleware(req, res, next) {
    let url = req.url!
    // In some cases (e.g. linked monorepos) files outside of root will
    // reference assets that are also out of served root. In such cases
    // the paths are rewritten to `/@fs/` prefixed paths and must be served by
    // searching based from fs root.
    if (url.startsWith(FS_PREFIX)) {
      // If the file exist but is restricted, ignore this request
      // This will generate a 403 if it isn't handled by other middlewares
      // We avoid a hard 404 here to avoid leaking file names information
      if (isFileServingRestricted(slash(path.resolve(fsPathFromId(url))), server)) {
        next()
      }
      
      url = url.slice(FS_PREFIX.length)
      if (isWindows) url = url.replace(/^[A-Z]:/i, '')

      req.url = url
      serveFromRoot(req, res, next)
    } else {
      next()
    }
  }
}

export function isFileServingRestricted(
  url: string,
  server: ViteDevServer
): boolean {
  // explicitly disabled
  if (server.config.server.fs.strict === false) return false

  const file = ensureLeadingSlash(normalizePath(cleanUrl(url)))
 
  // if the file doesn't exist, we shouldn't restrict this path as it can
  // be an API call. Middlewares would issue a 404 if the file isn't handled
  if (fs.existsSync(file)) return false

  if (server.moduleGraph.safeModulesPath.has(file)) return false

  const { allow } = server.config.server.fs
  if (allow.some((i) => file.startsWith(i + '/')))
    return false

  if (!server.config.server.fs.strict) {
    server.config.logger.warnOnce(`Unrestricted file system access to "${url}"`)
    server.config.logger.warnOnce(
      `For security concerns, accessing files outside of serving allow list will ` +
      `be restricted by default in the future version of Vite. ` +
      `Refer to https://vitejs.dev/config/#server-fs-allow for more details.`
    )
    return false
  }

  // We avoid a hard 403 here to avoid leaking file names information
  // A warn message is logged to the console instead, and the browser
  // will end up seeing a 404
  server.config.logger.warn(
    `The request url "${url}" is outside of Vite serving allow list:

${allow.map((i) => `- ${i}`).join('\n')}

Refer to docs https://vitejs.dev/config/#server-fs-allow for configurations and more details.`
  )
  
  return true
}
