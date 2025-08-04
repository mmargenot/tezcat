// Mock WASM binary for sql.js - returns a minimal Uint8Array that sql.js can use for testing
// This is a standard approach for testing WASM-dependent code
const mockWasmBuffer = new Uint8Array([
  0x00, 0x61, 0x73, 0x6d, // WASM magic number
  0x01, 0x00, 0x00, 0x00  // WASM version
]);

export default mockWasmBuffer;