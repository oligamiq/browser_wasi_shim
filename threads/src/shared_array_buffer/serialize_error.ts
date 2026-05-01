/**
 * Represents an Error object in a serializable format for thread transfer.
 */
export type SerializedError = {
  message: string;
  name: string;
  stack?: string;
  cause?: unknown;
};

/**
 * Converts an Error object into a serializable format.
 *
 * @param error The Error object to serialize.
 * @returns A SerializedError object.
 */
export const serialize = (error: Error): SerializedError => {
  return {
    message: error.message,
    name: error.name,
    stack: error.stack,
    cause: error.cause,
  };
};

/**
 * Reconstructs an Error object from its serialized representation.
 *
 * @param serializedError The serialized error data.
 * @returns A new Error instance.
 */
export const deserialize = (serializedError: SerializedError): Error => {
  const error = new Error(serializedError.message);
  error.name = serializedError.name;
  error.stack = serializedError.stack?.replace(/.wasm:/g, ".wasm\n");
  error.cause = serializedError.cause;
  return error;
};
