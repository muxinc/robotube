const globalWithDomException = globalThis as typeof globalThis & {
  DOMException?: typeof DOMException;
};

if (typeof globalWithDomException.DOMException === "undefined") {
  class DOMExceptionPolyfill extends Error {
    constructor(message = "", name = "Error") {
      super(message);
      this.name = name;
    }
  }

  globalWithDomException.DOMException = DOMExceptionPolyfill as unknown as typeof DOMException;
}
