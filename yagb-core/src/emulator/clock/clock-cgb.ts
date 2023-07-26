import { Bus, ReadHandler, WriteHandler } from '../bus';

import { Apu } from '../apu';
import { Clock } from '../clock';
import { Ppu } from '../ppu';
import { Serial } from '../serial';
import { Timer } from '../timer';
import { cgbRegisters } from '../cgb-registers';

export class ClockCgb implements Clock {
    constructor(private ppu: Ppu, private timer: Timer, private serial: Serial, private apu: Apu) {}

    reset(): void {
        this.cpuCycles = 0;
        this.extraCpuCycles = 0;
        this.doubleSpeed = false;
        this.dividerAccCycles = 0;
        this.speedSwitchPending = false;
    }

    install(bus: Bus): void {
        bus.map(cgbRegisters.key1, this.key1Read, this.key1Write);
    }

    increment(cpuCycles: number) {
        this.incrementImpl(cpuCycles);

        while (this.extraCpuCycles !== 0) {
            const cycles = this.extraCpuCycles;
            this.extraCpuCycles = 0;

            this.incrementImpl(cycles);
        }
    }

    pauseCpu(oneMHzCyles: number): void {
        this.extraCpuCycles += (this.doubleSpeed ? 2 : 1) * oneMHzCyles;
    }

    resetCpuCycles(): void {
        this.cpuCycles = 0;
    }

    notifyStop(): void {
        if (!this.speedSwitchPending) return;

        this.doubleSpeed = !this.doubleSpeed;
        this.incrementImpl(130996);

        this.dividerAccCycles = 0;
        this.speedSwitchPending = false;
    }

    isDoubleSpeed(): boolean {
        return this.doubleSpeed;
    }

    private key1Read: ReadHandler = (_) => 0x7e | (this.doubleSpeed ? 0x80 : 0x00) | (this.speedSwitchPending ? 0x01 : 0x00);
    private key1Write: WriteHandler = (_, value) => (this.speedSwitchPending = (value & 0x01) !== 0);

    // Unit: 1MHz / 2MMHz
    private incrementImpl(cpuCycles: number) {
        if (this.doubleSpeed) {
            this.dividerAccCycles += cpuCycles;

            const oneMHzCycles = this.dividerAccCycles >>> 1;
            this.dividerAccCycles &= 0x01;

            this.ppu.cycle(2 * cpuCycles);
            this.timer.cycle(cpuCycles);
            this.serial.cycle(cpuCycles);
            this.apu.cycle(oneMHzCycles);

            this.cpuCycles += cpuCycles;
        } else {
            this.ppu.cycle(4 * cpuCycles);
            this.timer.cycle(cpuCycles);
            this.serial.cycle(cpuCycles);
            this.apu.cycle(cpuCycles);

            this.cpuCycles += 2 * cpuCycles;
        }
    }

    cpuCycles = 0;

    // Unit: 1MHz / 2MHz
    private extraCpuCycles = 0;

    private dividerAccCycles = 0;

    private doubleSpeed = false;

    private speedSwitchPending = false;
}
