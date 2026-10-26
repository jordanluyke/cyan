import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ytDlpSpawnEnv } from '../../target/util/yt-dlp-env.js'

describe('ytDlpSpawnEnv', () => {
    test('points Python at a CA bundle when SSL_CERT_FILE is unset', () => {
        const env = ytDlpSpawnEnv({})
        expect(env.SSL_CERT_FILE).toBeTruthy()
        expect(readFileSync(env.SSL_CERT_FILE, 'utf8')).toContain('-----BEGIN CERTIFICATE-----')
        expect(env.REQUESTS_CA_BUNDLE).toBe(env.SSL_CERT_FILE)
        expect(env.CURL_CA_BUNDLE).toBe(env.SSL_CERT_FILE)
    })

    test('keeps an existing CA file and the rest of the environment', () => {
        const dir = mkdtempSync(join(tmpdir(), 'cyan-ca-'))
        const file = join(dir, 'ca.pem')
        writeFileSync(file, 'custom')
        try {
            const env = ytDlpSpawnEnv({ SSL_CERT_FILE: file, PATH: '/usr/bin' })
            expect(env.SSL_CERT_FILE).toBe(file)
            expect(env.REQUESTS_CA_BUNDLE).toBe(file)
            expect(env.CURL_CA_BUNDLE).toBe(file)
            expect(env.PATH).toBe('/usr/bin')
        } finally {
            rmSync(dir, { recursive: true, force: true })
        }
    })

    test('replaces a CA file that is not on disk', () => {
        const env = ytDlpSpawnEnv({ SSL_CERT_FILE: '/no/such/cacert.pem' })
        expect(env.SSL_CERT_FILE).not.toBe('/no/such/cacert.pem')
        expect(readFileSync(env.SSL_CERT_FILE, 'utf8')).toContain('-----BEGIN CERTIFICATE-----')
    })
})
