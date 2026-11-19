import { createRequire } from 'node:module'
import {
    installMessageSnapshotGuard,
    withSnapshotCacheDisabled,
} from '../../target/channel/snapshot-cache.js'

const require = createRequire(import.meta.url)
const { ChannelType, Client, GatewayIntentBits, MessageManager } = require('discord.js')

// Captured before any test installs the guard. ESM imports are hoisted, and
// the guard is not installed at import time.
const discordAdd = MessageManager.prototype._add

const author = { id: '444', username: 'ada', discriminator: '0', avatar: null }

function setup() {
    const client = new Client({
        intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages],
    })
    const guild = client.guilds._add({ id: '222', name: 'g' })
    const general = client.channels._add(
        { id: '333', type: ChannelType.GuildText, guild_id: '222', name: 'general' },
        guild,
    )
    const memes = client.channels._add(
        { id: '334', type: ChannelType.GuildText, guild_id: '222', name: 'memes' },
        guild,
    )
    return { general, memes }
}

function messageData(id, channelId, content) {
    return {
        id,
        channel_id: channelId,
        guild_id: '222',
        content,
        timestamp: new Date().toISOString(),
        author,
        mentions: [],
        mention_roles: [],
        attachments: [
            {
                id: 'a1',
                filename: 'keep.png',
                size: 10,
                url: 'https://cdn.discordapp.com/keep.png',
                proxy_url: 'https://media.discordapp.net/keep.png',
            },
        ],
        embeds: [{ title: 'keep me', description: 'real embed' }],
    }
}

/** A forward whose snapshot is an older copy of `messageId` from `channelId`. */
function forwardData(id, channelId, messageId, sourceChannelId, snapshotContent) {
    return {
        id,
        channel_id: channelId,
        guild_id: '222',
        content: '',
        timestamp: new Date().toISOString(),
        author,
        mentions: [],
        mention_roles: [],
        attachments: [],
        embeds: [],
        message_reference: {
            type: 1,
            message_id: messageId,
            channel_id: sourceChannelId,
            guild_id: '222',
        },
        message_snapshots: [
            {
                message: {
                    content: snapshotContent,
                    attachments: [],
                    embeds: [],
                    mentions: [],
                    mention_roles: [],
                    timestamp: new Date().toISOString(),
                    type: 0,
                },
            },
        ],
    }
}

describe('forward snapshots during uncached fetch', () => {
    test('discord.js patches a cached message when a forward is constructed', () => {
        const { general } = setup()
        const original = discordAdd.call(
            general.messages,
            messageData('999', '333', 'edited content'),
            true,
        )
        discordAdd.call(
            general.messages,
            forwardData('1000', '333', '999', '333', 'OLD snapshot content'),
            false,
        )

        expect(original.content).toBe('OLD snapshot content')
        expect(original.attachments.size).toBe(0)
        expect(original.embeds.length).toBe(0)
    })

    test('a cached forward does not revert or insert the source message', () => {
        installMessageSnapshotGuard()
        const { general, memes } = setup()
        const original = general.messages._add(messageData('999', '333', 'edited content'), true)

        // Same shape as gateway messageCreate and a cache:true fetch.
        memes.messages._add(forwardData('1000', '334', '999', '333', 'OLD snapshot content'), true)

        expect(original.content).toBe('edited content')
        expect(original.attachments.size).toBe(1)
        expect(original.embeds).toHaveLength(1)
        expect(general.messages.cache.get('999')).toBe(original)
        expect(memes.messages.cache.has('1000')).toBe(true)
        expect(general.messages.cache.has('1000')).toBe(false)
    })

    test('a forward of an uncached message does not keep the snapshot', () => {
        installMessageSnapshotGuard()
        const { general } = setup()

        general.messages._add(
            forwardData('1000', '333', '999', '333', 'OLD snapshot content'),
            true,
        )

        expect(general.messages.cache.has('999')).toBe(false)
        expect(general.messages.cache.has('1000')).toBe(true)
    })

    test('a reply still updates the cached parent', () => {
        installMessageSnapshotGuard()
        const { general } = setup()
        const original = general.messages._add(messageData('999', '333', 'edited content'), true)

        general.messages._add(
            {
                ...messageData('1000', '333', 'a reply'),
                message_reference: {
                    type: 0,
                    message_id: '999',
                    channel_id: '333',
                    guild_id: '222',
                },
                referenced_message: messageData('999', '333', 'from the reply payload'),
            },
            true,
        )

        expect(original.content).toBe('from the reply payload')
        expect(general.messages.cache.get('999')).toBe(original)
    })

    test('a cache:false reply does not patch the cached parent', async () => {
        installMessageSnapshotGuard()
        const { general } = setup()
        const original = general.messages._add(messageData('999', '333', 'edited content'), true)

        await withSnapshotCacheDisabled(async () => {
            general.messages._add(
                {
                    ...messageData('1000', '333', 'a reply'),
                    message_reference: {
                        type: 0,
                        message_id: '999',
                        channel_id: '333',
                        guild_id: '222',
                    },
                    referenced_message: messageData('999', '333', 'stale reply payload'),
                },
                false,
            )
        })

        expect(original.content).toBe('edited content')
        expect(original.attachments.size).toBe(1)
        expect(general.messages.cache.has('1000')).toBe(false)
    })

    test('cache:false add does not revert or retain the snapshot', async () => {
        const { general, memes } = setup()
        const original = general.messages._add(messageData('999', '333', 'edited content'), true)

        await withSnapshotCacheDisabled(async () => {
            // Same shape as MessageManager._fetchMany(..., cache: false).
            memes.messages._add(
                forwardData('1000', '334', '999', '333', 'OLD snapshot content'),
                false,
            )
        })

        expect(original.content).toBe('edited content')
        expect(original.attachments.size).toBe(1)
        expect(original.embeds).toHaveLength(1)
        expect(general.messages.cache.has('999')).toBe(true)
        expect(general.messages.cache.get('999')).toBe(original)
        // The forward itself was fetched with cache:false, and its snapshot
        // must not be inserted under the original id or the forward id.
        expect(memes.messages.cache.size).toBe(0)
        expect(general.messages.cache.size).toBe(1)
    })

    test('a snapshot of an uncached message is not kept', async () => {
        const { general } = setup()

        await withSnapshotCacheDisabled(async () => {
            general.messages._add(
                forwardData('1000', '333', '999', '333', 'OLD snapshot content'),
                false,
            )
        })

        expect([...general.messages.cache.keys()]).toEqual([])
    })

    test('gateway adds still cache while an export is in progress', async () => {
        const { general } = setup()

        await withSnapshotCacheDisabled(async () => {
            // messageCreate calls _add with one argument (cache defaults to true).
            general.messages._add(messageData('555', '333', 'just arrived'))
        })

        expect(general.messages.cache.get('555')?.content).toBe('just arrived')
    })

    test('overlapping exports keep the guard until the last one finishes', async () => {
        const { general } = setup()
        const original = general.messages._add(messageData('999', '333', 'edited content'), true)
        let release
        const gate = new Promise((resolve) => {
            release = resolve
        })

        const first = withSnapshotCacheDisabled(async () => {
            await gate
        })
        await withSnapshotCacheDisabled(async () => {
            general.messages._add(
                forwardData('1000', '333', '999', '333', 'OLD snapshot content'),
                false,
            )
        })

        expect(original.content).toBe('edited content')
        release()
        await first

        general.messages._add(messageData('556', '333', 'after exports'), true)
        expect(general.messages.cache.get('556')?.content).toBe('after exports')
    })
})
