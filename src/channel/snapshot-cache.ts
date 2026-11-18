import { MessageManager } from 'discord.js'

type MessageAdd = (this: unknown, data: unknown, cache?: boolean) => unknown

/**
 * Non-zero while a forward payload is inside `Message` construction.
 * The constructor calls `_add` again for each snapshot, using the original
 * message id. That write must not touch the live cache.
 */
let forwardDepth = 0

/**
 * Non-zero while a `cache: false` add is inside `Message` construction.
 * Export fetches opt out of caching, but a reply's referenced message and a
 * forward's snapshot are added again with the default `cache: true`.
 */
let uncachedDepth = 0

let originalAdd: MessageAdd | null = null

function isForwardPayload(data: unknown): boolean {
    if (data == null || typeof data !== 'object') return false
    return Array.isArray((data as { message_snapshots?: unknown }).message_snapshots)
}

function patchedAdd(this: unknown, data: unknown, cache?: boolean): unknown {
    const add = originalAdd
    if (add == null) {
        throw new Error('message _add patch is not installed')
    }
    // A forward's snapshot is frozen at forward time. discord.js stores it
    // under the original message id and, on a cache hit, patches that message
    // in place — reverting later edits and dropping attachments. Replies are
    // left alone: their nested add is the live referenced message.
    if (forwardDepth > 0 || uncachedDepth > 0) {
        return add.call(this, data, false)
    }
    const forwarding = isForwardPayload(data)
    const uncached = cache === false
    if (forwarding) forwardDepth++
    if (uncached) uncachedDepth++
    try {
        return add.call(this, data, cache)
    } finally {
        if (forwarding) forwardDepth--
        if (uncached) uncachedDepth--
    }
}

/**
 * Install the forward-snapshot guard for the rest of the process.
 * Gateway events, context menus, and message fetches all construct forwards.
 * Safe to call more than once.
 */
export function installMessageSnapshotGuard(): void {
    if (originalAdd != null) return
    const proto = MessageManager.prototype as unknown as { _add: MessageAdd }
    originalAdd = proto._add
    proto._add = patchedAdd
}

/**
 * Run `fn` with the snapshot guard installed.
 *
 * `channel.messages.fetch({ cache: false })` still constructs each `Message`.
 * For a forward, that constructor calls `referencedChannel.messages._add(snapshot)`
 * with the default `cache: true`. If that id is already cached, discord.js
 * patches it in place. The guard stays installed after `fn` returns so a later
 * gateway event cannot reapply the same snapshot.
 */
export async function withSnapshotCacheDisabled<T>(fn: () => Promise<T>): Promise<T> {
    installMessageSnapshotGuard()
    return fn()
}
