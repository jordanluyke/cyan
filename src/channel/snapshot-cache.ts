import { MessageManager } from 'discord.js'

type MessageAdd = (this: unknown, data: unknown, cache?: boolean) => unknown

/**
 * How many `withSnapshotCacheDisabled` calls are on the stack. The prototype
 * patch stays installed until the last one returns.
 */
let installed = 0

/**
 * Non-zero while a `cache: false` add is inside `new Message`. Forward
 * snapshots call `_add` again from that constructor; those must not cache.
 */
let constructingUncached = 0

let originalAdd: MessageAdd | null = null

function patchedAdd(this: unknown, data: unknown, cache?: boolean): unknown {
    const add = originalAdd
    if (add == null) {
        throw new Error('message _add patch is not installed')
    }
    if (constructingUncached > 0) {
        return add.call(this, data, false)
    }
    if (cache === false) {
        constructingUncached++
        try {
            return add.call(this, data, false)
        } finally {
            constructingUncached--
        }
    }
    return add.call(this, data, cache)
}

/**
 * Run `fn` without letting forward snapshots write into the message cache.
 *
 * `channel.messages.fetch({ cache: false })` still constructs each `Message`.
 * For a forward, that constructor calls `referencedChannel.messages._add(snapshot)`
 * with the default `cache: true`. If that id is already cached, discord.js
 * patches it in place — an export then reverts edits and drops attachments on
 * the live message. If it is not cached, the snapshot stays in the cache for
 * the life of the process.
 *
 * Only adds that opted out of caching are affected, and only the synchronous
 * constructor work they trigger. Gateway `messageCreate` still caches.
 */
export async function withSnapshotCacheDisabled<T>(fn: () => Promise<T>): Promise<T> {
    const proto = MessageManager.prototype as unknown as { _add: MessageAdd }
    if (installed === 0) {
        originalAdd = proto._add
        proto._add = patchedAdd
    }
    installed++
    try {
        return await fn()
    } finally {
        installed--
        if (installed === 0) {
            if (originalAdd != null) proto._add = originalAdd
            originalAdd = null
            constructingUncached = 0
        }
    }
}
