export class SampleQueue {
    constructor(public readonly sampleRate: number) {
        this.capacity = sampleRate / 2;

        this.channelLeftData = new Float32Array(this.capacity);
        this.channelRightData = new Float32Array(this.capacity);
    }

    reset(): void {
        this.channelLeftData.fill(0);
        this.channelRightData.fill(0);
        this.length = 0;
        this.nextSample = 0;
    }

    push(left: number, right: number): void {
        this.channelLeftData[this.nextSample] = left;
        this.channelRightData[this.nextSample] = right;

        if (this.length < this.capacity) {
            this.length++;
        }
        this.nextSample = (this.nextSample + 1) % this.capacity;
    }

    getLength(): number {
        return this.length;
    }

    fill(buffer: AudioBuffer): void {
        let iIn = (this.nextSample - this.length + this.capacity) % this.capacity;

        const channelLeft = buffer.getChannelData(0);
        const channelRight = buffer.getChannelData(1);

        for (let iOut = 0; iOut < buffer.length && this.length > 0; iOut++) {
            channelLeft[iOut] = this.channelLeftData[iIn];
            channelRight[iOut] = this.channelRightData[iIn];

            iIn = (iIn + 1) % this.capacity;
            this.length--;
        }
    }

    private channelLeftData: Float32Array;
    private channelRightData: Float32Array;

    private length = 0;
    private nextSample = 0;

    private capacity: number;
}
