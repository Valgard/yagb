import { AddressingMode, Instruction, Operation, decodeInstruction } from './instruction';

import { Bus } from './bus';
import { Clock } from './clock';
import { SystemInterface } from './system';
import { hex16 } from '../helper/format';

export const enum r8 {
    f = 0,
    a = 1,
    c = 2,
    b = 3,
    e = 4,
    d = 5,
    l = 6,
    h = 7,
}

export const enum r16 {
    af = 0,
    bc = 1,
    de = 2,
    hl = 3,
    sp = 4,
}

export const enum flag {
    z = 0x80,
    n = 0x40,
    h = 0x20,
    c = 0x10,
}

export interface CpuState {
    r8: Uint8Array;
    r16: Uint16Array;
    p: number;
    enableInterrupts: boolean;
}

function extendSign8(x: number): number {
    return x & 0x80 ? -((~x + 1) & 0xff) : x;
}

export class Cpu {
    constructor(private bus: Bus, private clock: Clock, private system: SystemInterface) {
        const r16 = new Uint16Array(5);
        const r8 = new Uint8Array(r16.buffer);

        this.state = {
            r8,
            r16,
            p: 0,
            enableInterrupts: false,
        };
    }

    reset() {
        this.state.r16[r16.af] = 0x0100;
        this.state.r16[r16.bc] = 0x0013;
        this.state.r16[r16.de] = 0x00d8;
        this.state.r16[r16.hl] = 0x014d;
        this.state.p = 0x0100;
        this.state.r16[r16.sp] = 0xfffe;
        this.state.enableInterrupts = false;
    }

    step(count: number): void {
        for (let i = 0; i < count; i++) this.dispatch(decodeInstruction(this.bus, this.state.p));
    }

    printState(): string {
        return `af=${hex16(this.state.r16[r16.af])} bc=${hex16(this.state.r16[r16.bc])} de=${hex16(this.state.r16[r16.de])} hl=${hex16(
            this.state.r16[r16.hl]
        )} s=${hex16(this.state.r16[r16.sp])} p=${hex16(this.state.p)} interrupts=${this.state.enableInterrupts ? 'on' : 'off'}`;
    }

    private dispatch(instruction: Instruction): number {
        switch (instruction.operation) {
            case Operation.dec: {
                this.clock.increment(instruction.cycles);

                const operand = this.getArg1(instruction);
                const result = operand - 1;

                this.setArg1(instruction, result);
                this.state.r8[r8.f] =
                    (this.state.r8[r8.f] & flag.c) |
                    flag.n |
                    ((result & 0xff) === 0 ? flag.z : 0) |
                    ((((operand & 0x0f) - 1) & 0xf0) > 0 ? flag.h : 0);

                this.state.p = (this.state.p + instruction.len) & 0xffff;
                return instruction.cycles;
            }

            case Operation.di:
                this.clock.increment(instruction.cycles);

                this.state.enableInterrupts = false;

                this.state.p = (this.state.p + instruction.len) & 0xffff;
                return instruction.cycles;

            case Operation.inc: {
                this.clock.increment(instruction.cycles);

                const operand = this.getArg1(instruction);
                const result = operand + 1;

                this.setArg1(instruction, result);
                this.state.r8[r8.f] =
                    (this.state.r8[r8.f] & flag.c) |
                    ((result & 0xff) === 0 ? flag.z : 0) |
                    ((((operand & 0x0f) + 1) & 0xf0) > 0 ? flag.h : 0);

                this.state.p = (this.state.p + instruction.len) & 0xffff;
                return instruction.cycles;
            }

            case Operation.jp:
                this.clock.increment(instruction.cycles);

                this.state.p = this.getArg1(instruction);
                return instruction.cycles;

            case Operation.jrnz: {
                const condition = (this.state.r8[r8.f] & flag.z) === 0;
                const cycles = instruction.cycles + (condition ? 1 : 0);
                this.clock.increment(cycles);

                const displacement = extendSign8(this.getArg1(instruction));

                this.state.p = (this.state.p + instruction.len) & 0xffff;
                if (condition) {
                    this.state.p = (this.state.p + displacement) & 0xffff;
                }

                return cycles;
            }

            case Operation.ld: {
                this.clock.increment(instruction.cycles);

                this.setArg1(instruction, this.getArg2(instruction));

                this.state.p = (this.state.p + instruction.len) & 0xffff;
                return instruction.cycles;
            }

            case Operation.ldd: {
                this.clock.increment(instruction.cycles);

                this.setArg1(instruction, this.getArg2(instruction));
                this.state.r16[r16.hl] = (this.state.r16[r16.hl] - 1) & 0xffff;

                this.state.p = (this.state.p + instruction.len) & 0xffff;
                return instruction.cycles;
            }

            case Operation.ldh:
                this.clock.increment(instruction.cycles);

                this.bus.write((0xff00 + this.getArg1(instruction)) & 0xffff, this.getArg2(instruction));

                this.state.p = (this.state.p + instruction.len) & 0xffff;
                return instruction.cycles;

            case Operation.ldi: {
                this.clock.increment(instruction.cycles);

                this.setArg1(instruction, this.getArg2(instruction));
                this.state.r16[r16.hl] = (this.state.r16[r16.hl] + 1) & 0xffff;

                this.state.p = (this.state.p + instruction.len) & 0xffff;
                return instruction.cycles;
            }

            case Operation.nop:
                this.clock.increment(instruction.cycles);

                this.state.p = (this.state.p + instruction.len) & 0xffff;
                return instruction.cycles;

            case Operation.xor:
                this.clock.increment(instruction.cycles);

                this.state.r8[r8.a] = this.state.r8[r8.a] ^ this.getArg1(instruction);
                this.state.r8[r8.f] = this.state.r8[r8.a] ? 0 : flag.z;

                this.state.p = (this.state.p + instruction.len) & 0xffff;
                return instruction.cycles;

            default:
                this.system.break('invalid instruction');
                return 0;
        }
    }

    private getArg1(instruction: Instruction) {
        switch (instruction.addressingMode) {
            case AddressingMode.imm8:
            case AddressingMode.imm8_reg8:
                return this.bus.read((this.state.p + instruction.par1) & 0xffff);

            case AddressingMode.imm16:
                return this.bus.read16((this.state.p + instruction.par1) & 0xffff);

            case AddressingMode.reg8:
                return this.state.r8[instruction.par1];

            case AddressingMode.reg16_imm16:
                return this.state.r16[instruction.par1];

            case AddressingMode.reg8_imm8:
                return this.state.r8[instruction.par1];

            case AddressingMode.ind_reg8:
                return this.bus.read(this.state.r16[instruction.par1]);

            default:
                throw new Error('bad addressing mode');
        }
    }

    private setArg1(instruction: Instruction, value: number) {
        switch (instruction.addressingMode) {
            case AddressingMode.reg8:
                this.state.r8[instruction.par1] = value;
                break;

            case AddressingMode.reg16_imm16:
                this.state.r16[instruction.par1] = value;
                break;

            case AddressingMode.reg8_imm8:
                this.state.r8[instruction.par1] = value;
                break;

            case AddressingMode.ind_reg8:
                this.bus.write(this.state.r16[instruction.par1], value & 0xff);
                break;

            default:
                throw new Error('bad addressing mode');
        }
    }

    private getArg2(instruction: Instruction) {
        switch (instruction.addressingMode) {
            case AddressingMode.reg16_imm16:
                return this.bus.read16((this.state.p + instruction.par2) & 0xffff);

            case AddressingMode.reg8_imm8:
                return this.bus.read((this.state.p + instruction.par2) & 0xffff);

            case AddressingMode.ind_reg8:
            case AddressingMode.imm8_reg8:
                return this.state.r8[instruction.par2];

            default:
                throw new Error('bad addressing mode');
        }
    }

    readonly state: CpuState;
}
