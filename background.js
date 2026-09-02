chrome.action.onClicked.addListener(async tab => {
  const appUrl = new URL(chrome.runtime.getURL("lmaa.html"));
  if (tab && typeof tab.url === "string") {
    try {
      const sourceUrl = new URL(tab.url);
      const youtubeHosts = new Set(["youtube.com", "www.youtube.com", "m.youtube.com", "youtu.be"]);
      if ((sourceUrl.protocol === "https:" || sourceUrl.protocol === "http:") && youtubeHosts.has(sourceUrl.hostname.toLowerCase())) {
        appUrl.searchParams.set("youtubeUrl", sourceUrl.toString());
      }
    } catch (_) {
      // Non-URL browser pages simply open the normal home view.
    }
  }
  await chrome.tabs.create({ url: appUrl.toString() });
});
