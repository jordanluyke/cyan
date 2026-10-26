import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { rootCertificates } from 'node:tls'

let bundlePath: string | undefined

/**
 * python.org builds on macOS ship without a CA file, so yt-dlp's python3
 * fails TLS with CERTIFICATE_VERIFY_FAILED. Node already has the Mozilla
 * roots; hand Python a copy of those.
 */
export function ytDlpCaBundlePath(): string {
    if (bundlePath != null) return bundlePath
    const dir = join(tmpdir(), 'cyan')
    mkdirSync(dir, { recursive: true })
    const path = join(dir, 'cacert.pem')
    writeFileSync(path, rootCertificates.join('\n') + '\n')
    bundlePath = path
    return path
}

function usableCaFile(path: string | undefined): string | undefined {
    if (path == null || path.length === 0) return undefined
    return existsSync(path) ? path : undefined
}

/** Env for the yt-dlp child. Keeps a caller-supplied CA file when it exists. */
export function ytDlpSpawnEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
    const ca = usableCaFile(base.SSL_CERT_FILE) ?? ytDlpCaBundlePath()
    return {
        ...base,
        SSL_CERT_FILE: ca,
        REQUESTS_CA_BUNDLE: usableCaFile(base.REQUESTS_CA_BUNDLE) ?? ca,
        CURL_CA_BUNDLE: usableCaFile(base.CURL_CA_BUNDLE) ?? ca,
    }
}
