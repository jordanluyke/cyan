import { randomInt } from 'crypto'

/** Cap so the reply can list every face. */
export const MAX_DICE = 100
/** `crypto.randomInt` is unbiased for ranges well below 2^48. */
export const MAX_SIDES = 1_000_000

const EXAMPLE = 'Example: /roll 2d8'
const DICE = /^(\d*)d(\d+)$/
const BARE = /^(\d+)$/

export type DieRoller = (sides: number) => number

export type DiceRoll = {
    count: number
    sides: number
    rolls: number[]
}

export function rollDice(input: string, roller: DieRoller = rollFace): DiceRoll {
    const { count, sides } = parseDice(input)
    const rolls: number[] = []
    for (let i = 0; i < count; i++) rolls.push(roller(sides))
    return { count, sides, rolls }
}

export function formatDiceRoll(roll: DiceRoll): string {
    const label = `${roll.count}d${roll.sides}`
    if (roll.rolls.length === 1) return `${label}: ${roll.rolls[0]}`
    const total = roll.rolls.reduce((sum, face) => sum + face, 0)
    return `${label}: ${roll.rolls.join(', ')} = ${total}`
}

function parseDice(input: string): { count: number; sides: number } {
    const spec = input.trim().toLowerCase().replace(/\s+/g, '')
    const dice = DICE.exec(spec)
    const bare = dice == null ? BARE.exec(spec) : null
    if (dice == null && bare == null) throw new Error(EXAMPLE)

    let count = 1
    let sides: number
    if (dice != null) {
        if (dice[1] !== '') count = Number(dice[1])
        sides = Number(dice[2])
    } else {
        sides = Number(bare[1])
    }

    if (!Number.isSafeInteger(count) || count < 1 || count > MAX_DICE) {
        throw new Error(`Roll 1-${MAX_DICE} dice`)
    }
    if (!Number.isSafeInteger(sides) || sides < 2 || sides > MAX_SIDES) {
        throw new Error(`Die needs 2-${MAX_SIDES.toLocaleString('en-US')} sides`)
    }
    return { count, sides }
}

/** Inclusive 1..sides. `randomInt` rejects out-of-range samples, so faces are uniform. */
function rollFace(sides: number): number {
    return randomInt(1, sides + 1)
}
