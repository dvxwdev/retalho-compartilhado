/** In-place radix-2 FFT. The length must be a power of two. */
export function fft(real: Float64Array, imaginary: Float64Array, inverse = false): void {
  const size = real.length;
  for (let index = 1, swapped = 0; index < size; index += 1) {
    let bit = size >> 1;
    for (; swapped & bit; bit >>= 1) swapped ^= bit;
    swapped ^= bit;
    if (index < swapped) {
      [real[index], real[swapped]] = [real[swapped]!, real[index]!];
      [imaginary[index], imaginary[swapped]] = [imaginary[swapped]!, imaginary[index]!];
    }
  }
  for (let length = 2; length <= size; length <<= 1) {
    const angle = ((inverse ? 2 : -2) * Math.PI) / length;
    const stepReal = Math.cos(angle);
    const stepImaginary = Math.sin(angle);
    for (let start = 0; start < size; start += length) {
      let turnReal = 1;
      let turnImaginary = 0;
      for (let offset = 0; offset < length / 2; offset += 1) {
        const even = start + offset;
        const odd = even + length / 2;
        const oddReal = real[odd]! * turnReal - imaginary[odd]! * turnImaginary;
        const oddImaginary = real[odd]! * turnImaginary + imaginary[odd]! * turnReal;
        real[odd] = real[even]! - oddReal;
        imaginary[odd] = imaginary[even]! - oddImaginary;
        real[even]! += oddReal;
        imaginary[even]! += oddImaginary;
        const nextTurn = turnReal * stepReal - turnImaginary * stepImaginary;
        turnImaginary = turnReal * stepImaginary + turnImaginary * stepReal;
        turnReal = nextTurn;
      }
    }
  }
  if (inverse) {
    for (let index = 0; index < size; index += 1) {
      real[index]! /= size;
      imaginary[index]! /= size;
    }
  }
}
