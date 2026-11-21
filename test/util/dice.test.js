import { MAX_DICE, MAX_SIDES, formatDiceRoll, rollDice } from '../../target/util/dice.js'

describe('roll dice', () => {
    test('rolls each die and prints the faces with a total', () => {
        const faces = [4, 6]
        let i = 0
        const roll = rollDice('2d8', () => faces[i++])
        expect(roll).toEqual({ count: 2, sides: 8, rolls: [4, 6] })
        expect(formatDiceRoll(roll)).toBe('2d8: 4, 6 = 10')
    })

    test('a single die omits the sum', () => {
        expect(formatDiceRoll(rollDice('d20', () => 17))).toBe('1d20: 17')
    })

    test('a bare number is one die with that many sides', () => {
        expect(rollDice('  20 ', () => 3)).toEqual({ count: 1, sides: 20, rolls: [3] })
    })

    test('ignores case and spaces', () => {
        const sides = []
        rollDice('2 D 8', (n) => {
            sides.push(n)
            return 1
        })
        expect(sides).toEqual([8, 8])
    })

    test('accepts the dice cap and rejects one past it', () => {
        expect(rollDice(`${MAX_DICE}d6`, () => 1).rolls).toHaveLength(MAX_DICE)
        expect(() => rollDice(`${MAX_DICE + 1}d6`)).toThrow(`Roll 1-${MAX_DICE} dice`)
        expect(() => rollDice('0d6')).toThrow(`Roll 1-${MAX_DICE} dice`)
    })

    test('rejects junk and a one-sided die', () => {
        expect(() => rollDice('2d8+3')).toThrow('Example: /roll 2d8')
        expect(() => rollDice('')).toThrow('Example: /roll 2d8')
        expect(() => rollDice(`d${MAX_SIDES + 1}`)).toThrow(
            `Die needs 2-${MAX_SIDES.toLocaleString('en-US')} sides`
        )
        expect(() => rollDice('2d1')).toThrow(
            `Die needs 2-${MAX_SIDES.toLocaleString('en-US')} sides`
        )
    })

    test('crypto rolls stay on the die', () => {
        for (let i = 0; i < 40; i++) {
            const roll = rollDice('2d6')
            expect(roll.rolls).toHaveLength(2)
            for (const face of roll.rolls) {
                expect(face).toBeGreaterThanOrEqual(1)
                expect(face).toBeLessThanOrEqual(6)
            }
        }
    })
})
