import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// The ISA checks immediate width before data stack arity.
const immediates = new Uint8Array(256);
immediates[1] = 1;
immediates[2] = 4;
immediates.fill(2, 0x30, 0x34);
const arity = new Uint8Array(256);
arity.fill(2, 0x10, 0x1f);
arity.fill(2, 0x20, 0x23);
for (const op of [3, 4, 0x17, 0x1b, 0x31, 0x32, 0x40, 0x50, 0x51, 0x53]) arity[op] = 1;
for (const op of [5, 6, 0x41]) arity[op] = 2;
arity[7] = 3;
const grows = new Uint8Array(256);
for (const op of [1, 2, 4, 6, 0x52]) grows[op] = 1;

function execute(code: Buffer, input: Buffer) {
  const stack = new Int32Array(256);
  const memory = new Int32Array(256);
  const returns = new Uint32Array(64);
  const output = Buffer.allocUnsafe(65536);
  let pc = 0, depth = 0, frame = 0, cursor = 0, written = 0;
  let status = 10;

  instructions: for (let steps = 0; steps < 1_000_000; steps++) {
    if (pc < 0 || pc >= code.length) { status = 9; break; }
    const op = code[pc++];
    if (pc + immediates[op] > code.length) { status = 9; break; }
    if (depth < arity[op]) { status = 2; break; }
    if (depth === 256 && grows[op]) { status = 3; break; }
    const binary = (op >= 0x10 && op <= 0x1e && op !== 0x17 && op !== 0x1b) ||
      (op >= 0x20 && op <= 0x22);
    if (binary) {
      const b = stack[--depth], a = stack[depth - 1];
      if (op >= 0x13 && op <= 0x16 && b === 0) { status = 4; break; }
      let value: number;
      switch (op) {
        case 0x10: value = a + b; break;
        case 0x11: value = a - b; break;
        case 0x12: value = Math.imul(a, b); break;
        case 0x13: value = a / b; break;
        case 0x14: value = a % b; break;
        case 0x15: value = (a >>> 0) / (b >>> 0); break;
        case 0x16: value = (a >>> 0) % (b >>> 0); break;
        case 0x18: value = a & b; break;
        case 0x19: value = a | b; break;
        case 0x1a: value = a ^ b; break;
        case 0x1c: value = a << b; break;
        case 0x1d: value = a >> b; break;
        case 0x1e: value = a >>> b; break;
        case 0x20: value = +(a === b); break;
        case 0x21: value = +(a < b); break;
        case 0x22: value = +((a >>> 0) < (b >>> 0)); break;
        default: status = 5; break instructions;
      }
      stack[depth - 1] = value; // Typed assignment truncates and wraps to signed 32 bits.
      continue;
    }

    switch (op) {
      case 0: status = 0; break instructions;
      case 1: stack[depth++] = code.readInt8(pc++); break;
      case 2: stack[depth++] = code.readInt32LE(pc); pc += 4; break;
      case 3: depth--; break;
      case 4: stack[depth] = stack[depth - 1]; depth++; break;
      case 5: {
        const top = stack[depth - 1];
        stack[depth - 1] = stack[depth - 2];
        stack[depth - 2] = top;
        break;
      }
      case 6: stack[depth] = stack[depth - 2]; depth++; break;
      case 7: {
        const third = stack[depth - 3];
        stack[depth - 3] = stack[depth - 2];
        stack[depth - 2] = stack[depth - 1];
        stack[depth - 1] = third;
        break;
      }
      case 0x17: stack[depth - 1] = -stack[depth - 1]; break;
      case 0x1b: stack[depth - 1] = ~stack[depth - 1]; break;
      case 0x30: case 0x31: case 0x32: {
        const offset = code.readInt16LE(pc);
        pc += 2;
        if (op === 0x30 || (stack[--depth] === 0) === (op === 0x31)) pc += offset;
        break;
      }
      case 0x33:
        if (frame === 64) { status = 7; break instructions; }
        returns[frame++] = pc + 2;
        pc = code.readUInt16LE(pc);
        break;
      case 0x34:
        if (frame === 0) { status = 8; break instructions; }
        pc = returns[--frame];
        break;
      case 0x40: {
        const address = stack[depth - 1];
        if (address >>> 8) { status = 6; break instructions; }
        stack[depth - 1] = memory[address];
        break;
      }
      case 0x41: {
        const address = stack[--depth];
        if (address >>> 8) { status = 6; break instructions; }
        memory[address] = stack[--depth];
        break;
      }
      case 0x50: {
        const digits = String(stack[--depth]);
        if (written + digits.length > output.length) { status = 11; break instructions; }
        written += output.write(digits, written, 'ascii');
        break;
      }
      case 0x51:
        if (written === output.length) { status = 11; break instructions; }
        output[written++] = stack[--depth];
        break;
      case 0x52: stack[depth++] = cursor < input.length ? input[cursor++] : -1; break;
      case 0x53: status = stack[--depth] & 255; break instructions;
      default: status = 5; break instructions;
    }
  }
  return { status, bytes: output.subarray(0, written) };
}

const inputDirectory = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const outputDirectory = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';
for (const entry of readdirSync(inputDirectory, { withFileTypes: true })) {
  if (!entry.isDirectory()) continue;
  const from = join(inputDirectory, entry.name);
  const to = join(outputDirectory, entry.name);
  const result = execute(readFileSync(join(from, 'program.bin')), readFileSync(join(from, 'input.bin')));
  mkdirSync(to, { recursive: true });
  writeFileSync(join(to, 'stdout.bin'), result.bytes);
  writeFileSync(join(to, 'exit.txt'), String(result.status));
}
