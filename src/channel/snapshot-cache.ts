import { Collection, Message, MessageManager } from 'discord.js'

type MessageAdd = (this: unknown, data: unknown, cache?: boolean) => unknown

/** Constructor is private in the typings and public at runtime. */
const MessageConstructor = Message as unknown as new (
    client: Message['client'],
    data: unknown,
) => Message

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
        const created = add.call(this, data, cache)
        // Still inside forwardDepth. Rebuilding snapshots calls `_add` again,
        // and that write must stay uncached.
        if (forwarding) keepEveryForwardSnapshot(created, data)
        return created
    } finally {
        if (forwarding) forwardDepth--
        if (uncached) uncachedDepth--
    }
}

/**
 * discord.js stores every snapshot under the forwarded message's id, so a
 * multi-message forward keeps only the last one. Ask Cyan, Draw, and export
 * then drop the rest. Rebuild the collection while nested adds are forced
 * uncached — a cache hit would patch the live original.
 */
function keepEveryForwardSnapshot(created: unknown, data: unknown): void {
    if (created == null || typeof created !== 'object') return
    const raw = (data as { message_snapshots?: unknown }).message_snapshots
    if (!Array.isArray(raw) || raw.length <= 1) return

    const message = created as Message
    const reference = message.reference
    if (reference?.messageId == null || reference.channelId == null) return

        const channel = message.client.channels.resolve(reference.channelId)
        const manager =
            channel != null && channel.isTextBased()
                ? (channel.messages as unknown as {
                      _add(data: unknown, cache?: boolean): Message
                  })
                : null
        const snapshots = new Collection<string, Message>()
    for (let index = 0; index < raw.length; index++) {
        const entry = raw[index]
        const body =
            entry != null && typeof entry === 'object'
                ? (entry as { message?: Record<string, unknown> }).message
                : undefined
        // Drop nested snapshots. Rebuilding them would run `Message` construction
        // again and discord.js would key those by this same reference id.
        const { message_snapshots: _nested, ...rest } = body ?? {}
        const snapshotData = {
            ...rest,
            id: reference.messageId,
            channel_id: reference.channelId,
            guild_id: reference.guildId,
        }
        const snapshot = (
            manager != null
                ? manager._add(snapshotData, false)
                : new MessageConstructor(message.client, snapshotData)
        ) as Message
        snapshots.set(String(index), snapshot)
    }
    message.messageSnapshots = snapshots as unknown as Message['messageSnapshots']
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
