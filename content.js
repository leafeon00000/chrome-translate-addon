/**
 * 対訳ビューア本体（iframe実体方式）。
 *
 * アクティブタブの現在のDOMをスナップショットし、左右2枚の <iframe srcdoc> に
 * 「実体ごと」描画する。左=原文そのまま、右=同じ描画のテキストノードを英→日翻訳で上書きする。
 * これによりレイアウト・画像・装飾を保ったまま対訳表示する。
 *
 * 翻訳は Chrome 138+ 内蔵の Translator API（オンデバイス翻訳）を使用する。
 * 要素にマウスオーバーすると左右の対応要素がハイライトされ、スクロールも概ね連動する（ベストエフォート）。
 *
 * 2回目の注入（アイコン再クリック）では多重起動ガードが働き、オーバーレイを除去して原状復帰する。
 */
;(() => {
  'use strict'

  // ---- 多重起動ガード（トグル）-------------------------------------------
  if (window.__translateAddonActive) {
    if (typeof window.__translateAddonTeardown === 'function') {
      window.__translateAddonTeardown()
    }
    return
  }
  window.__translateAddonActive = true

  // 翻訳元・翻訳先の言語（英→日 固定）
  const SOURCE_LANG = 'en'
  const TARGET_LANG = 'ja'
  // 同一 translator インスタンスへ同時に投げる翻訳リクエスト数の上限
  const CONCURRENCY = 4
  // テキストノードを翻訳対象から除外する親タグ
  const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEXTAREA', 'CODE', 'PRE'])
  // srcdoc 内に注入するハイライト用スタイル
  // 眩しさを抑えるため、薄い半透明の背景＋左端のアクセントバーのみ（明るい塗り・太枠は使わない）
  const HL_STYLE =
    '.tv-hl{background-color:rgba(255,213,79,0.18) !important;' +
    'box-shadow:inset 3px 0 0 rgba(245,166,35,0.7) !important;border-radius:2px !important;}'

  /**
   * 現在のDOMをスナップショットし、iframe srcdoc 用のHTML文字列を生成する。
   * - 相対URL解決のため <base> を挿入
   * - 再実行による不具合を避けるため <script> を除去
   * - 遅延読み込み画像を可能な範囲で実体化
   * - 全要素に連番 data-tv-id を付与（左右iframeで対応付け＆ハイライトに使う）
   * - ハイライト用スタイルを注入
   *
   * @returns {string} srcdoc に渡すHTML（DOCTYPE付き）
   */
  function buildSnapshot() {
    const clone = document.documentElement.cloneNode(true)

    // <script> を除去（静的描画にして再読込・リダイレクト・二重ロードを防ぐ）
    clone.querySelectorAll('script').forEach((n) => n.remove())

    // 遅延読み込み画像の実体化（ベストエフォート）
    clone.querySelectorAll('img').forEach((img) => {
      const lazy =
        img.getAttribute('data-src') ||
        img.getAttribute('data-original') ||
        img.getAttribute('data-lazy-src')
      if (lazy && !img.getAttribute('src')) img.setAttribute('src', lazy)
      const lazySet = img.getAttribute('data-srcset')
      if (lazySet && !img.getAttribute('srcset')) img.setAttribute('srcset', lazySet)
    })

    // 全要素へ連番IDを付与（左右で同一スナップショットなのでIDが一致する）
    let idx = 0
    clone.querySelectorAll('*').forEach((el) => {
      el.setAttribute('data-tv-id', String(idx++))
    })

    // <head> 先頭に <base> とハイライト用 <style> を挿入
    let head = clone.querySelector('head')
    if (!head) {
      head = document.createElement('head')
      clone.insertBefore(head, clone.firstChild)
    }
    const base = document.createElement('base')
    base.setAttribute('href', location.href)
    head.insertBefore(base, head.firstChild)

    const style = document.createElement('style')
    style.textContent = HL_STYLE
    head.appendChild(style)

    // DOCTYPE を付けて標準モードで描画させる
    return '<!DOCTYPE html>\n' + clone.outerHTML
  }

  /**
   * 全画面オーバーレイ（ツールバー＋左右iframe）を構築して追加する。
   *
   * @param {string} snapshotHtml srcdoc に渡すHTML
   * @returns {{ overlay: HTMLElement, translateBtn: HTMLButtonElement, status: HTMLElement,
   *            progressFill: HTMLElement, leftIframe: HTMLIFrameElement, rightIframe: HTMLIFrameElement }}
   */
  function buildOverlay(snapshotHtml) {
    const overlay = document.createElement('div')
    overlay.className = 'tv-overlay'

    // --- ツールバー ---
    const toolbar = document.createElement('div')
    toolbar.className = 'tv-toolbar'

    const title = document.createElement('span')
    title.className = 'tv-title'
    title.textContent = '対訳ビューア（英→日）'

    const translateBtn = document.createElement('button')
    translateBtn.className = 'tv-btn tv-btn-primary'
    translateBtn.textContent = '翻訳開始'

    const status = document.createElement('span')
    status.className = 'tv-status'
    status.textContent = '左=原文 / 右=訳（「翻訳開始」を押してください）'

    const progress = document.createElement('div')
    progress.className = 'tv-progress'
    const progressFill = document.createElement('div')
    progressFill.className = 'tv-progress-fill'
    progress.appendChild(progressFill)

    const closeBtn = document.createElement('button')
    closeBtn.className = 'tv-btn tv-btn-close'
    closeBtn.textContent = '閉じる ✕'
    closeBtn.addEventListener('click', () => window.__translateAddonTeardown())

    toolbar.append(title, translateBtn, status, progress, closeBtn)

    // --- 左右iframe ---
    const columns = document.createElement('div')
    columns.className = 'tv-columns'

    const leftIframe = document.createElement('iframe')
    leftIframe.className = 'tv-iframe'
    const rightIframe = document.createElement('iframe')
    rightIframe.className = 'tv-iframe'

    // load Promise を「srcdoc 設定前」に張る。srcdoc を設定した直後は一瞬 about:blank
    // （readyState=complete）が存在するため、readyState で判定すると空ドキュメントを
    // 掴んでしまう。確実に「snapshot がロードされた本物のドキュメント」を得るため、
    // 未接続のうちに srcdoc を設定 → 接続で発火する唯一の load を待つ。
    // snapshot（data-tv-id を含む本物のドキュメント）がロードされた時だけ解決する。
    // 空の about:blank の load は無視する。
    const loadPromise = (iframe) =>
      new Promise((resolve) => {
        const onload = () => {
          const doc = iframe.contentDocument
          if (doc && doc.querySelector('[data-tv-id]')) {
            iframe.removeEventListener('load', onload)
            resolve(doc)
          }
        }
        iframe.addEventListener('load', onload)
      })
    const leftLoaded = loadPromise(leftIframe)
    const rightLoaded = loadPromise(rightIframe)

    // 未接続の状態で srcdoc を設定（この時点では load は発火しない）
    leftIframe.srcdoc = snapshotHtml
    rightIframe.srcdoc = snapshotHtml

    // 接続すると snapshot のロードが始まり、load が一度だけ発火する
    columns.append(leftIframe, rightIframe)
    overlay.append(toolbar, columns)
    document.documentElement.appendChild(overlay)

    return {
      overlay,
      translateBtn,
      status,
      progressFill,
      leftIframe,
      rightIframe,
      leftLoaded,
      rightLoaded,
    }
  }

  /**
   * 配列を指定並列数で順に処理する簡易ワーカープール。
   *
   * @template T
   * @param {T[]} items 処理対象
   * @param {(item: T, index: number) => Promise<void>} worker 各要素を処理する非同期関数
   * @param {number} concurrency 同時実行数
   * @returns {Promise<void>}
   */
  async function runPool(items, worker, concurrency) {
    let cursor = 0
    const runners = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
      while (cursor < items.length) {
        const index = cursor++
        await worker(items[index], index)
      }
    })
    await Promise.all(runners)
  }

  /**
   * ドキュメント内の翻訳対象テキストノードを収集する。
   * script/style など除外タグ配下・英字を含まないノードはスキップする。
   *
   * @param {Document} doc 走査対象のドキュメント
   * @returns {Text[]} 翻訳対象テキストノードの配列
   */
  function collectTextNodes(doc) {
    const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        const parent = node.parentElement
        if (!parent || SKIP_TAGS.has(parent.tagName)) return NodeFilter.FILTER_REJECT
        // 英字を含むテキストのみ翻訳対象にする（記号・数字だけの節約）
        if (!/[A-Za-z]/.test(node.nodeValue)) return NodeFilter.FILTER_REJECT
        return NodeFilter.FILTER_ACCEPT
      },
    })
    const nodes = []
    let n
    while ((n = walker.nextNode())) nodes.push(n)
    return nodes
  }

  /**
   * 右iframe内のテキストノードを Translator API で翻訳し、その場で上書きする。
   * 周囲のHTML/CSS/画像はそのまま残るため、レイアウト・画像を保ったまま訳文に置き換わる。
   *
   * @param {Document} rightDoc 右iframeのドキュメント
   * @param {HTMLElement} status 状態表示用の要素
   * @param {HTMLElement} progressFill 進捗バーの伸縮要素
   * @returns {Promise<void>}
   */
  async function translateDocument(rightDoc, status, progressFill) {
    if (typeof Translator === 'undefined') {
      status.textContent = 'このブラウザは内蔵翻訳に未対応です（Chrome 138以降のデスクトップ版が必要）'
      return
    }

    status.textContent = '翻訳エンジンを確認中…'
    let availability
    try {
      availability = await Translator.availability({
        sourceLanguage: SOURCE_LANG,
        targetLanguage: TARGET_LANG,
      })
    } catch (err) {
      status.textContent = '翻訳エンジンの確認に失敗しました'
      console.error(err)
      return
    }
    if (availability === 'unavailable') {
      status.textContent = '英→日の翻訳モデルが利用できません（環境を確認してください）'
      return
    }

    let translator
    try {
      status.textContent =
        availability === 'available' ? '翻訳エンジンを準備中…' : '翻訳モデルをダウンロード中…'
      translator = await Translator.create({
        sourceLanguage: SOURCE_LANG,
        targetLanguage: TARGET_LANG,
        monitor(m) {
          m.addEventListener('downloadprogress', (e) => {
            const pct = Math.round(e.loaded * 100)
            status.textContent = `翻訳モデルをダウンロード中… ${pct}%`
            progressFill.style.width = `${pct}%`
          })
        },
      })
    } catch (err) {
      status.textContent = '翻訳エンジンの初期化に失敗しました'
      console.error(err)
      return
    }

    const nodes = collectTextNodes(rightDoc)
    progressFill.style.width = '0%'
    let done = 0

    await runPool(
      nodes,
      async (node) => {
        const raw = node.nodeValue
        const trimmed = raw.trim()
        try {
          const translated = await translator.translate(trimmed)
          // 前後の空白を保ってノードを置換する（語間スペースの崩れを防ぐ）
          const lead = raw.match(/^\s*/)[0]
          const trail = raw.match(/\s*$/)[0]
          node.nodeValue = lead + translated + trail
        } catch (err) {
          // 1ノードの失敗は全体を止めない（原文のまま残す）
          console.error('テキスト翻訳に失敗:', err)
        } finally {
          done++
          progressFill.style.width = `${Math.round((done / nodes.length) * 100)}%`
          status.textContent = `翻訳中… ${done} / ${nodes.length}`
        }
      },
      CONCURRENCY
    )

    status.textContent = `完了: ${nodes.length} 箇所を翻訳しました`
    if (typeof translator.destroy === 'function') translator.destroy()
  }

  // ---- メイン -------------------------------------------------------------

  // 厳格CSP等で document.body が無い等の異常時に備える
  if (!document.body) {
    window.__translateAddonActive = false
    alert('このページでは対訳ビューアを開けませんでした。')
    return
  }

  const snapshotHtml = buildSnapshot()

  // 元ページのスクロールを止め、オーバーレイで覆う
  const prevHtmlOverflow = document.documentElement.style.overflow
  document.documentElement.style.overflow = 'hidden'

  const { overlay, translateBtn, status, progressFill, leftIframe, rightIframe, leftLoaded, rightLoaded } =
    buildOverlay(snapshotHtml)

  // --- 翻訳開始ボタン（ユーザー操作起点でモデルDL／翻訳を実行）---
  translateBtn.addEventListener('click', async () => {
    translateBtn.disabled = true
    const rightDoc = await rightLoaded
    if (!rightDoc) {
      status.textContent = 'このページは描画できませんでした（CSP制限の可能性）'
      return
    }
    await translateDocument(rightDoc, status, progressFill)
  })

  // --- 両iframeのロード後にハイライト連動・スクロール同期をセットアップ ---
  let highlightedId = null
  let isSyncing = false

  Promise.all([leftLoaded, rightLoaded]).then(([leftDoc, rightDoc]) => {
    if (!leftDoc || !rightDoc) {
      status.textContent = 'このページは描画できませんでした（CSP制限の可能性）'
      return
    }
    const docs = [leftDoc, rightDoc]

    /**
     * 指定IDの要素を左右両iframeでハイライト付け外しする。
     * @param {string|null} id data-tv-id
     * @param {boolean} on 付与するか
     * @returns {void}
     */
    function setHighlight(id, on) {
      if (id == null) return
      for (const doc of docs) {
        const el = doc.querySelector(`[data-tv-id="${id}"]`)
        if (el) el.classList.toggle('tv-hl', on)
      }
    }

    /**
     * 要素が「直下に実テキストを持つ」か判定する（空のラッパー要素を除外するため）。
     * @param {Element} el 判定対象
     * @returns {boolean} 直下に空白以外のテキストノードがあれば true
     */
    function hasDirectText(el) {
      for (const node of el.childNodes) {
        if (node.nodeType === 3 && /\S/.test(node.nodeValue)) return true
      }
      return false
    }

    /**
     * カーソル位置の要素から、ハイライトすべき「テキストを持つ最も近い要素」を探す。
     * 大きな div/section/body などラッパーは対象外にして「全体が光る」のを防ぐ。
     * @param {Element} start e.target
     * @returns {Element|null} ハイライト対象、なければ null
     */
    function findTextEl(start) {
      let cur = start
      while (cur && cur.getAttribute) {
        if (cur.hasAttribute('data-tv-id') && hasDirectText(cur)) return cur
        cur = cur.parentElement
      }
      return null
    }

    // 各iframe内に hover リスナーを張る（同一オリジンなので可能）
    for (const doc of docs) {
      doc.addEventListener('mouseover', (e) => {
        const el = findTextEl(e.target)
        // テキストを持つ要素の上でなければ（余白・ラッパー上）ハイライトを消す
        if (!el) {
          if (highlightedId !== null) {
            setHighlight(highlightedId, false)
            highlightedId = null
          }
          return
        }
        const id = el.getAttribute('data-tv-id')
        if (id === highlightedId) return
        setHighlight(highlightedId, false)
        highlightedId = id
        setHighlight(highlightedId, true)
      })
      doc.addEventListener('mouseleave', () => {
        setHighlight(highlightedId, false)
        highlightedId = null
      })
    }

    // スクロール同期（data-tv-id基準。画面上端に来た要素を、もう一方でも上端へ揃える）

    /**
     * 実際にスクロールした要素（source 側）を返す。
     * ルートスクロールは event.target が document/html/body になるため scrollingElement に正規化する。
     *
     * @param {Event} e scroll イベント
     * @param {Document} sdoc 発火側ドキュメント
     * @returns {Element} スクロールした要素
     */
    function getSourceScroller(e, sdoc) {
      const t = e.target
      if (t === sdoc || t === sdoc.documentElement || t === sdoc.body) return sdoc.scrollingElement
      return t
    }

    /**
     * source 側のスクロール要素に対応する target 側のスクロール要素を返す。
     * 左右は同一スナップショットなので data-tv-id で対応付けられる。
     * ※ CSSの overflow からの推測（overflow-x:hidden が overflow-y を auto 化する等）は
     *   誤りやすいので、実際にスクロールした要素を基準にする。
     *
     * @param {Element} src source 側スクロール要素
     * @param {Document} sdoc 発火側ドキュメント
     * @param {Document} tdoc 追従側ドキュメント
     * @returns {Element} target 側スクロール要素
     */
    function getTargetScroller(src, sdoc, tdoc) {
      if (src === sdoc.scrollingElement) return tdoc.scrollingElement
      const id = src.getAttribute && src.getAttribute('data-tv-id')
      return (id && tdoc.querySelector(`[data-tv-id="${id}"]`)) || tdoc.scrollingElement
    }

    /**
     * スクロール率（scrollTop / 最大スクロール量）で左右を連動させる。
     * 固定ヘッダーや高さ差があっても必ず動く堅牢な方式（厳密一致はしない）。
     *
     * @param {Event} e scroll イベント
     * @param {Document} sdoc スクロール操作された側のドキュメント
     * @param {Document} tdoc 追従させる側のドキュメント
     * @returns {void}
     */
    function syncScroll(e, sdoc, tdoc) {
      if (isSyncing) return
      isSyncing = true
      const src = getSourceScroller(e, sdoc)
      const tgt = getTargetScroller(src, sdoc, tdoc)
      if (src && tgt) {
        const max = src.scrollHeight - src.clientHeight
        const ratio = max > 0 ? src.scrollTop / max : 0
        tgt.scrollTop = ratio * (tgt.scrollHeight - tgt.clientHeight)
      }
      requestAnimationFrame(() => {
        isSyncing = false
      })
    }

    // scroll はバブルしないが、キャプチャフェーズなら内側コンテナのスクロールも捕捉できる
    leftDoc.addEventListener('scroll', (e) => syncScroll(e, leftDoc, rightDoc), true)
    rightDoc.addEventListener('scroll', (e) => syncScroll(e, rightDoc, leftDoc), true)
  })

  // --- Esc キーで閉じる ---
  function onKeydown(e) {
    if (e.key === 'Escape') window.__translateAddonTeardown()
  }
  document.addEventListener('keydown', onKeydown, true)

  // --- teardown（原状復帰）---
  window.__translateAddonTeardown = () => {
    document.removeEventListener('keydown', onKeydown, true)
    overlay.remove()
    document.documentElement.style.overflow = prevHtmlOverflow
    window.__translateAddonActive = false
    delete window.__translateAddonTeardown
  }
})()
