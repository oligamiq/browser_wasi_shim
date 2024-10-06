// Uint8ArrayをBase64に変換する関数
export function uint8ArrayToBase64(uint8Array) {
  const base64Table =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  let result = "";

  for (let i = 0; i < uint8Array.length; i += 3) {
    const bytes =
      (uint8Array[i] << 16) |
      (uint8Array[i + 1] << 8) |
      (uint8Array[i + 2] || 0);

    result += base64Table[(bytes >> 18) & 63];
    result += base64Table[(bytes >> 12) & 63];
    result += i + 1 < uint8Array.length ? base64Table[(bytes >> 6) & 63] : "=";
    result += i + 2 < uint8Array.length ? base64Table[bytes & 63] : "=";
  }

  return result;
}

// Base64をUint8Arrayに変換する関数
export function base64ToUint8Array(base64) {
  const base64Table =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  const padding = base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0;
  const length = (base64.length * 3) / 4 - padding;
  const uint8Array = new Uint8Array(length);

  let byteIndex = 0;

  for (let i = 0; i < base64.length; i += 4) {
    const bytes =
      (base64Table.indexOf(base64[i]) << 18) |
      (base64Table.indexOf(base64[i + 1]) << 12) |
      (base64Table.indexOf(base64[i + 2]) << 6) |
      base64Table.indexOf(base64[i + 3]);

    if (byteIndex < length) uint8Array[byteIndex++] = (bytes >> 16) & 255;
    if (byteIndex < length) uint8Array[byteIndex++] = (bytes >> 8) & 255;
    if (byteIndex < length) uint8Array[byteIndex++] = bytes & 255;
  }

  return uint8Array;
}
