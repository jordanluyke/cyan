import { createRequire } from 'node:module'
import { installMessageSnapshotGuard } from '../../target/channel/snapshot-cache.js'
import { DiscordUtil, MAX_IMAGE_BYTES } from '../../target/util/discord-util.js'

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

describe('discord hosted media urls', () => {
    test('allows Discord attachment and proxy hosts', () => {
        expect(
            DiscordUtil.isDiscordHostedMediaUrl(
                'https://cdn.discordapp.com/attachments/1/2/pic.png',
            ),
        ).toBe(true)
        expect(
            DiscordUtil.isDiscordHostedMediaUrl(
                'https://media.discordapp.net/attachments/1/2/pic.jpg',
            ),
        ).toBe(true)
        expect(
            DiscordUtil.isDiscordHostedMediaUrl(
                'https://images-ext-1.discordapp.net/external/abc/https/example.com/pic.png',
            ),
        ).toBe(true)
    })

    test('rejects hosts the bot must not fetch', () => {
        expect(DiscordUtil.isDiscordHostedMediaUrl('http://cdn.discordapp.com/a.png')).toBe(false)
        expect(DiscordUtil.isDiscordHostedMediaUrl('https://evil.example/a.png')).toBe(false)
        expect(
            DiscordUtil.isDiscordHostedMediaUrl('https://cdn.discordapp.com.evil.example/a.png'),
        ).toBe(false)
        expect(
            DiscordUtil.isDiscordHostedMediaUrl('https://169.254.169.254/latest/meta-data'),
        ).toBe(false)
        expect(
            DiscordUtil.isDiscordHostedMediaUrl('https://user:pass@cdn.discordapp.com/a.png'),
        ).toBe(false)
        expect(DiscordUtil.isDiscordHostedMediaUrl('https://cdn.discordapp.com:444/a.png')).toBe(
            false,
        )
        expect(DiscordUtil.isDiscordHostedMediaUrl('file:///etc/passwd.png')).toBe(false)
        expect(DiscordUtil.isDiscordHostedMediaUrl('not a url')).toBe(false)
    })

    test('redirects may stay on Discord and must not leave', () => {
        const from = 'https://cdn.discordapp.com/attachments/1/2/pic.png'
        expect(DiscordUtil.discordMediaRedirectTarget(from, 200, null)).toBeNull()
        expect(
            DiscordUtil.discordMediaRedirectTarget(
                from,
                302,
                'https://media.discordapp.net/attachments/1/2/pic.png',
            ),
        ).toBe('https://media.discordapp.net/attachments/1/2/pic.png')
        expect(
            DiscordUtil.discordMediaRedirectTarget(from, 302, '/attachments/1/2/other.png'),
        ).toBe('https://cdn.discordapp.com/attachments/1/2/other.png')
        expect(() =>
            DiscordUtil.discordMediaRedirectTarget(
                from,
                302,
                'http://169.254.169.254/latest/meta-data',
            ),
        ).toThrow(/left Discord/)
        expect(() =>
            DiscordUtil.discordMediaRedirectTarget(from, 302, 'https://evil.example/pic.png'),
        ).toThrow(/left Discord/)
        expect(() =>
            DiscordUtil.discordMediaRedirectTarget(from, 302, '//169.254.169.254/latest/meta-data'),
        ).toThrow(/left Discord/)
        expect(() => DiscordUtil.discordMediaRedirectTarget(from, 302, null)).toThrow(
            /missing location/,
        )
        expect(() =>
            DiscordUtil.discordMediaRedirectTarget(
                from,
                302,
                'https://user:pass@cdn.discordapp.com/a.png',
            ),
        ).toThrow(/left Discord/)
    })

    test('embed images use the Discord proxy, not the origin url', () => {
        const proxy =
            'https://images-ext-1.discordapp.net/external/abc/https/evil.example/secret.png'
        const message = {
            attachments: { values: () => [].values() },
            embeds: [
                {
                    image: {
                        url: 'https://evil.example/secret.png',
                        proxyURL: proxy,
                    },
                },
            ],
        }
        expect(DiscordUtil.getMessageImages(message)).toEqual([proxy])
    })

    test('a Discord proxy is used even when its path has no image extension', () => {
        const proxy = 'https://media.discordapp.net/external/abc'
        const message = {
            attachments: { values: () => [].values() },
            embeds: [{ image: { url: 'https://evil.example/secret.png', proxyURL: proxy } }],
        }
        expect(DiscordUtil.getMessageImages(message)).toEqual([proxy])
    })

    test('a Discord-hosted embed url is kept when there is no proxy', () => {
        const url = 'https://cdn.discordapp.com/attachments/1/2/pic.png'
        const message = {
            attachments: { values: () => [].values() },
            embeds: [{ image: { url, proxyURL: null } }],
        }
        expect(DiscordUtil.getMessageImages(message)).toEqual([url])
    })

    test('an embed with only an external image url is not returned', () => {
        const message = {
            attachments: { values: () => [].values() },
            embeds: [{ image: { url: 'https://evil.example/secret.png', proxyURL: null } }],
        }
        expect(DiscordUtil.getMessageImages(message)).toEqual([])
    })

    test('attachments on other hosts are ignored', () => {
        const message = {
            attachments: {
                values: () =>
                    [
                        {
                            contentType: 'image/png',
                            name: 'pic.png',
                            size: 10,
                            url: 'https://evil.example/pic.png',
                        },
                        {
                            contentType: 'image/png',
                            name: 'ok.png',
                            size: 10,
                            url: 'https://cdn.discordapp.com/attachments/1/2/ok.png',
                        },
                    ].values(),
            },
            embeds: [],
        }
        expect(DiscordUtil.getMessageImages(message)).toEqual([
            'https://cdn.discordapp.com/attachments/1/2/ok.png',
        ])
    })
})

describe('forwarded message content', () => {
    const { ChannelType, Client, GatewayIntentBits } = require('discord.js')
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

    function snapshotMessage(content, extra = {}) {
        return {
            content,
            attachments: [],
            embeds: [],
            mentions: [],
            mention_roles: [],
            timestamp: new Date().toISOString(),
            type: 0,
            ...extra,
        }
    }

    function forward(channelId, snapshots) {
        return {
            id: '1000',
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
                message_id: '888',
                channel_id: '334',
                guild_id: '222',
            },
            message_snapshots: snapshots.map((message) => ({ message })),
        }
    }

    test('a normal message is unchanged when it has no snapshots', () => {
        installMessageSnapshotGuard()
        const { general } = setup()
        const message = general.messages._add(
            {
                id: '777',
                channel_id: '333',
                guild_id: '222',
                content: 'just a message',
                timestamp: new Date().toISOString(),
                author,
                mentions: [],
                mention_roles: [],
                attachments: [],
                embeds: [],
            },
            true,
        )
        expect(DiscordUtil.getMessageText(message)).toBe('just a message')
        expect(DiscordUtil.getMessageImages(message)).toEqual([])
    })

    test('reads every snapshot and does not use the live message from the other channel', () => {
        installMessageSnapshotGuard()
        const { general, memes } = setup()
        const live = memes.messages._add(
            {
                id: '888',
                channel_id: '334',
                guild_id: '222',
                content: 'LIVE text this channel must not fetch',
                timestamp: new Date().toISOString(),
                author,
                mentions: [],
                mention_roles: [],
                attachments: [
                    {
                        id: 'live',
                        filename: 'live.png',
                        size: 10,
                        url: 'https://cdn.discordapp.com/live.png',
                        proxy_url: 'https://media.discordapp.net/live.png',
                        content_type: 'image/png',
                    },
                ],
                embeds: [],
            },
            true,
        )

        const message = general.messages._add(
            forward('333', [
                snapshotMessage('first note', {
                    attachments: [
                        {
                            id: 'a2',
                            filename: 'one.png',
                            size: 10,
                            url: 'https://cdn.discordapp.com/one.png',
                            proxy_url: 'https://media.discordapp.net/one.png',
                            content_type: 'image/png',
                        },
                    ],
                }),
                snapshotMessage('', {
                    embeds: [
                        {
                            title: 'second title',
                            description: 'second body',
                            image: {
                                url: 'https://evil.example/secret.png',
                                proxy_url:
                                    'https://images-ext-1.discordapp.net/external/abc/pic.png',
                            },
                        },
                    ],
                    attachments: [
                        {
                            id: 'huge',
                            filename: 'huge.png',
                            size: MAX_IMAGE_BYTES + 1,
                            url: 'https://cdn.discordapp.com/huge.png',
                            proxy_url: 'https://media.discordapp.net/huge.png',
                            content_type: 'image/png',
                        },
                        {
                            id: 'off',
                            filename: 'off.png',
                            size: 10,
                            url: 'https://evil.example/off.png',
                            content_type: 'image/png',
                        },
                    ],
                }),
            ]),
            true,
        )

        expect(DiscordUtil.getMessageText(message)).toBe(
            'Forwarded:\nfirst note\n\nForwarded:\nsecond title\nsecond body',
        )
        expect(DiscordUtil.getMessageImages(message)).toEqual([
            'https://cdn.discordapp.com/one.png',
            'https://images-ext-1.discordapp.net/external/abc/pic.png',
        ])
        expect(live.content).toBe('LIVE text this channel must not fetch')
        expect(live.attachments.size).toBe(1)
        expect(DiscordUtil.getMessageText(live)).toBe('LIVE text this channel must not fetch')
        expect(DiscordUtil.getMessageImages(live)).toEqual(['https://cdn.discordapp.com/live.png'])
    })
})
