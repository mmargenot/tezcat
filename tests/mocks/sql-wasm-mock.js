// Mock WASM binary for sql.js - a minimal module header as an ArrayBuffer, matching the build's wasm loader
// This is a standard approach for testing WASM-dependent code
const mockWasmBuffer = new Uint8Array([
  0x00, 0x61, 0x73, 0x6d, // WASM magic number
  0x01, 0x00, 0x00, 0x00  // WASM version
]);

export default mockWasmBuffer.buffer;