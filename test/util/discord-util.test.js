import { createRequire } from 'node:module'
import { DiscordUtil } from '../../target/util/discord-util.js'

const require = createRequire(import.meta.url)
const { MessagePayload } = require('discord.js')

const target = {
    client: {
        options: { enforceNonce: false, failIfNotExists: true },
        user: { id: 'bot' },
    },
}

function resolvedMentions(options) {
    const payload = MessagePayload.create(target, options)
    payload.resolveBody()
    return payload.body.allowed_mentions
}

describe('suppressed mentions', () => {
    test('parse is empty so users, roles, and @everyone are not pinged', () => {
        expect(DiscordUtil.suppressedMentions()).toEqual({ parse: [], repliedUser: false })
    })

    test('a bare channel send omits allowed_mentions and Discord parses every type', () => {
        expect(resolvedMentions('@everyone <@123> <@&456>')).toBeUndefined()
    })

    test('model reply options suppress every mention type', () => {
        expect(
            resolvedMentions({
                content: '@everyone <@123> <@&456>',
                allowedMentions: DiscordUtil.suppressedMentions(),
            })
        ).toEqual({ parse: [], replied_user: false })
    })
})
