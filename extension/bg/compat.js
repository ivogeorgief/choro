// Firefox's build is Manifest V2, where the chrome.* namespace uses callbacks
// and returns nothing. Its browser.* namespace has the same functions and returns
// promises, which the rest of Choro relies on. Imported first by background.js.
if (globalThis.browser?.runtime?.id) {
  try {
    globalThis.chrome = globalThis.browser;
  } catch {
    try {
      Object.defineProperty(globalThis, "chrome", { value: globalThis.browser, configurable: true });
    } catch {
      /* left as it is; Firefox's MV3 chrome.* returns promises anyway */
    }
  }
}
