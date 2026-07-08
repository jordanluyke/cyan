import * as childProcess from 'child_process'
import * as fs from 'fs/promises'
import * as path from 'path'
import * as util from 'util'

(async () => {
    const __dirname = path.resolve()
    const targetDir = path.join(__dirname, 'target')

    try {
        console.log('Building...')
        await removeOutputFolder()
        await compile()
        console.log('Done')
        process.exit(0)
    } catch(err) {
        console.log(err)
        console.log('Exiting')
        process.exit(1)
    }

    async function removeOutputFolder() {
        try {
            await fs.rm(targetDir, {
                recursive: true
            })
        } catch(err) {}
        await fs.mkdir(targetDir)
    }

    async function compile() {
        try {
            const cmd = 'npx tsc'
            const { stdout, stderr } = await util.promisify(childProcess.exec)(cmd)
            if (stdout) console.log(stdout)
            if (stderr) console.error(stderr)
        } catch(err) {
            console.log('Compile failed')
            throw err
        }
    }
})()
