/**
 * Service worker。
 * ツールバーアイコンのクリックで、アクティブタブに content.css / content.js を注入する。
 * 2回目以降のクリックでは content.js 側の多重起動ガードが働き、対訳ビューアをトグルオフして原状復帰する。
 */

/**
 * 指定タブに対訳ビューアのスタイルとスクリプトを注入する。
 *
 * @param {chrome.tabs.Tab} tab クリックされたアクティブタブ
 * @returns {Promise<void>}
 */
async function injectViewer(tab) {
  // chrome:// などの特権ページには注入できないためガードする。
  if (!tab.id || !tab.url || /^(chrome|edge|about|chrome-extension|devtools):/i.test(tab.url)) {
    return
  }

  try {
    // CSS を先に入れてから JS を実行する。CSS は再注入されても害がない。
    await chrome.scripting.insertCSS({
      target: { tabId: tab.id },
      files: ['content.css'],
    })
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ['content.js'],
    })
  } catch (err) {
    // 注入失敗（権限不足など）はコンソールに残すだけにとどめる。
    console.error('対訳ビューアの注入に失敗しました:', err)
  }
}

chrome.action.onClicked.addListener((tab) => {
  injectViewer(tab)
})
