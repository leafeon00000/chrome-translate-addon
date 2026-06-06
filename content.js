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

  // 翻訳先は日本語固定。翻訳元は自動判別 or 手動選択（自動判別できない時のフォールバックは英語）
  const TARGET_LANG = 'ja'
  const DEFAULT_SOURCE_LANG = 'en'
  // 翻訳元の言語フィールドに出す選択肢（value=BCP-47基本コード, label=表示名）。先頭は自動判別。
  const SOURCE_LANG_OPTIONS = [
    ['auto', '自動判別'],
    ['en', '英語'],
    ['zh', '中国語'],
    ['ko', '韓国語'],
    ['fr', 'フランス語'],
    ['de', 'ドイツ語'],
    ['es', 'スペイン語'],
    ['it', 'イタリア語'],
    ['pt', 'ポルトガル語'],
    ['ru', 'ロシア語'],
  ]
  // 同一 translator インスタンスへ同時に投げる翻訳リクエスト数の上限
  const CONCURRENCY = 4
  // テキストノードを翻訳対象から除外する親タグ
  const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEXTAREA', 'CODE', 'PRE'])
  // 文を集約する際に「またいでよい」インライン要素。これら以外をブロック境界とみなす。
  // リンクや装飾（<a>/<b>/<em>…）の内外にまたがる1文を、ブロック単位で連結して扱うために使う。
  const INLINE_TAGS = new Set([
    'A', 'ABBR', 'B', 'BDI', 'BDO', 'CITE', 'DATA', 'DFN', 'EM', 'I', 'KBD', 'MARK',
    'Q', 'RP', 'RT', 'RUBY', 'S', 'SAMP', 'SMALL', 'SPAN', 'STRONG', 'SUB', 'SUP',
    'TIME', 'U', 'VAR', 'WBR', 'FONT', 'INS', 'DEL', 'BIG', 'TT', 'NOBR', 'LABEL',
  ])
  // srcdoc 内に注入するハイライト用スタイル
  // 眩しさを抑えるため、薄い半透明の背景＋左端のアクセントバーのみ（明るい塗り・太枠は使わない）
  const HL_STYLE =
    '.tv-hl{background-color:rgba(255,213,79,0.18) !important;' +
    'box-shadow:inset 3px 0 0 rgba(245,166,35,0.7) !important;border-radius:2px !important;}'
  // 左iframe（英語原文）へ注入する単語ホバー辞書ツールチップのスタイル。
  // ページ既存CSSに打ち消されないよう主要プロパティを !important で固定する。
  const WORD_TIP_STYLE =
    '.tv-word-tip{position:fixed !important;z-index:2147483647 !important;max-width:360px !important;' +
    'padding:6px 10px !important;border-radius:6px !important;background:rgba(17,24,39,0.96) !important;' +
    'color:#f9fafb !important;font-size:13px !important;line-height:1.45 !important;' +
    "font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Hiragino Kaku Gothic ProN',Meiryo,sans-serif !important;" +
    'box-shadow:0 4px 12px rgba(0,0,0,0.3) !important;pointer-events:none !important;' +
    'white-space:normal !important;display:none !important;}' +
    '.tv-word-tip.tv-word-tip-show{display:block !important;}' +
    '.tv-word-tip .tv-word-tip-src{color:#93c5fd !important;font-weight:600 !important;}' +
    '.tv-word-tip .tv-word-tip-arrow{color:#9ca3af !important;margin:0 6px !important;}' +
    '.tv-word-tip .tv-word-tip-dict{margin-top:5px !important;padding-top:5px !important;' +
    'border-top:1px solid rgba(255,255,255,0.15) !important;}' +
    '.tv-word-tip .tv-word-tip-row{font-size:12px !important;color:#e5e7eb !important;}' +
    '.tv-word-tip .tv-word-tip-loading{margin-top:5px !important;font-size:11px !important;' +
    'color:#9ca3af !important;font-style:italic !important;}'

  // 単語ホバー辞書（Prompt API / Gemini Nano）への指示。出力形式を固定するためのシステムプロンプト。
  // 「[品詞] 意味1／意味2／…」を品詞ごとに1行（最大4行）。前置きや例文は付けさせない。
  const DICT_SYSTEM_PROMPT =
    'あなたは英和辞典です。ユーザーが送る英単語1語について、日本語の意味を品詞ごとにまとめて返します。' +
    '各品詞につき1行、「[品詞] 意味1／意味2／…」の形式で出力します（例: [動] 走る／運営する）。' +
    '品詞略号は [動][名][形][副][前][接][代][助][間] のいずれかを必ず角括弧で囲んで行頭に置きます。' +
    '意味はその品詞で代表的なものを最大4個、全角スラッシュ「／」区切り。該当する品詞の行のみ、最大4行。' +
    '前置き・説明・例文・原語の繰り返し・箇条書き記号やコードブロックは一切付けず、指定の行だけを返してください。'

  // 品詞名（フル/略）→ 1文字略号 の対応（辞書行の行頭品詞を [略号] に正規化するのに使う）
  const POS_ABBR = {
    動詞: '動', 名詞: '名', 形容詞: '形', 副詞: '副', 前置詞: '前', 接続詞: '接',
    代名詞: '代', 助動詞: '助', 間投詞: '間', 感動詞: '間',
    動: '動', 名: '名', 形: '形', 副: '副', 前: '前', 接: '接', 代: '代', 助: '助', 間: '間',
  }

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
   * iframe に snapshot がロードされた本物のドキュメントを待つ。
   * srcdoc 設定直後は一瞬 about:blank（readyState=complete）が存在するため、readyState では
   * 判定せず、data-tv-id を含むドキュメントがロードされた load イベントだけを採用する。
   * 再翻訳時の srcdoc 再設定（再ロード）でも、設定前にこの Promise を張れば新ドキュメントを得られる。
   *
   * @param {HTMLIFrameElement} iframe 対象iframe
   * @returns {Promise<Document>} snapshot がロードされたドキュメント
   */
  function waitSnapshotLoad(iframe) {
    return new Promise((resolve) => {
      const onload = () => {
        const doc = iframe.contentDocument
        if (doc && doc.querySelector('[data-tv-id]')) {
          iframe.removeEventListener('load', onload)
          resolve(doc)
        }
      }
      iframe.addEventListener('load', onload)
    })
  }

  /**
   * 記録したスクロール率の位置へ復元する（ratio が null のときは何もしない）。
   * @param {Document} doc 対象ドキュメント
   * @param {number|null} ratio スクロール率（scrollTop / 最大スクロール量）
   * @returns {void}
   */
  function restoreScroll(doc, ratio) {
    if (ratio == null) return
    const se = doc.scrollingElement
    if (se) se.scrollTop = ratio * (se.scrollHeight - se.clientHeight)
  }

  /**
   * 全画面オーバーレイ（ツールバー＋左右iframe）を構築して追加する。
   *
   * @param {string} snapshotHtml srcdoc に渡すHTML
   * @returns {{ overlay: HTMLElement, srcLang: HTMLSelectElement, granularity: HTMLSelectElement,
   *            translateBtn: HTMLButtonElement, status: HTMLElement, progressFill: HTMLElement,
   *            leftIframe: HTMLIFrameElement, rightIframe: HTMLIFrameElement }}
   */
  function buildOverlay(snapshotHtml) {
    const overlay = document.createElement('div')
    overlay.className = 'tv-overlay'

    // --- ツールバー ---
    const toolbar = document.createElement('div')
    toolbar.className = 'tv-toolbar'

    const title = document.createElement('span')
    title.className = 'tv-title'
    title.textContent = '対訳ビューア（→日）'

    // 翻訳元の言語フィールド（先頭=自動判別。翻訳開始前に選択、実行中は無効化）
    const srcLang = document.createElement('select')
    srcLang.className = 'tv-srclang'
    srcLang.title = '翻訳元の言語（自動判別 / 手動選択）'
    for (const [value, label] of SOURCE_LANG_OPTIONS) {
      const opt = document.createElement('option')
      opt.value = value
      opt.textContent = label
      srcLang.appendChild(opt)
    }

    // 翻訳粒度の切替（翻訳開始前に選択。実行中は無効化する）
    const granularity = document.createElement('select')
    granularity.className = 'tv-granularity'
    granularity.title = '翻訳・ハイライトの単位'
    const optSentence = document.createElement('option')
    optSentence.value = 'sentence'
    optSentence.textContent = '文単位'
    const optBlock = document.createElement('option')
    optBlock.value = 'block'
    optBlock.textContent = 'まとまり単位'
    granularity.append(optSentence, optBlock)

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

    toolbar.append(title, srcLang, granularity, translateBtn, status, progress, closeBtn)

    // --- 左右iframe ---
    const columns = document.createElement('div')
    columns.className = 'tv-columns'

    const leftIframe = document.createElement('iframe')
    leftIframe.className = 'tv-iframe'
    const rightIframe = document.createElement('iframe')
    rightIframe.className = 'tv-iframe'

    // snapshot ロード完了を待つ Promise を「srcdoc 設定前」に張る（waitSnapshotLoad 参照）
    const leftLoaded = waitSnapshotLoad(leftIframe)
    const rightLoaded = waitSnapshotLoad(rightIframe)

    // 未接続の状態で srcdoc を設定（この時点では load は発火しない）
    leftIframe.srcdoc = snapshotHtml
    rightIframe.srcdoc = snapshotHtml

    // 接続すると snapshot のロードが始まり、load が一度だけ発火する
    columns.append(leftIframe, rightIframe)
    overlay.append(toolbar, columns)
    document.documentElement.appendChild(overlay)

    return {
      overlay,
      srcLang,
      granularity,
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
   * テキストノードが翻訳対象外か（script/style/pre/code など除外タグの配下か）を判定する。
   * @param {Text} node 判定対象
   * @returns {boolean} 除外すべきなら true
   */
  function isSkippedText(node) {
    // 祖先のいずれかが除外タグなら対象外。
    // 直接の親だけ見ると、<pre><code><span>...</span></code></pre> のように間に <span> 等が
    // 挟まったコードブロックを取りこぼし、翻訳対象にして中身を壊してしまうため祖先まで辿る。
    let el = node.parentElement
    if (!el) return true
    while (el) {
      if (SKIP_TAGS.has(el.tagName)) return true
      el = el.parentElement
    }
    return false
  }

  /**
   * テキストノードを集約する「ブロック」要素を返す。
   * 親を辿り、最初の非インライン要素（ブロック境界）を採用する。
   * これにより <a> 等の装飾をまたぐ文を1ブロックとして連結できる。
   * @param {Text} node 対象テキストノード
   * @returns {Element|null} 集約先のブロック要素
   */
  function nearestBlock(node) {
    let el = node.parentElement
    while (el && INLINE_TAGS.has(el.tagName) && el.parentElement) el = el.parentElement
    return el
  }

  /**
   * doc.body 内の全テキストノード（SKIP 配下を除く・空白/英字なしも含む）を
   * 文書順に走査し、最近接ブロック要素ごとにグループ化する。
   * 同一ブロックのテキストを連結することで、装飾またぎの完全な文を復元できる。
   *
   * @param {Document} doc 走査対象のドキュメント
   * @returns {Map<Element, Text[]>} ブロック要素 → テキストノード配列（各グループ内も文書順）
   */
  function groupTextNodesByBlock(doc) {
    const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        return isSkippedText(node) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT
      },
    })
    const groups = new Map()
    let n
    while ((n = walker.nextNode())) {
      const block = nearestBlock(n)
      if (!block) continue
      if (!groups.has(block)) groups.set(block, [])
      groups.get(block).push(n)
    }
    return groups
  }

  /**
   * 翻訳エンジン（Translator）の利用可否を確認し、インスタンスを生成して返す。
   * モデル未取得時はダウンロード進捗を status / progressFill に反映する。
   * 生成した translator は破棄せず返す（文翻訳と単語ホバー辞書で流用し、teardown で破棄）。
   *
   * @param {string} sourceLang 翻訳元の言語コード
   * @param {HTMLElement} status 状態表示用の要素
   * @param {HTMLElement} progressFill 進捗バーの伸縮要素
   * @returns {Promise<Translator|null>} 生成した translator（利用不可・失敗時は null）
   */
  async function prepareTranslator(sourceLang, status, progressFill) {
    if (typeof Translator === 'undefined') {
      status.textContent = 'このブラウザは内蔵翻訳に未対応です（Chrome 138以降のデスクトップ版が必要）'
      return null
    }

    status.textContent = '翻訳エンジンを確認中…'
    let availability
    try {
      availability = await Translator.availability({
        sourceLanguage: sourceLang,
        targetLanguage: TARGET_LANG,
      })
    } catch (err) {
      status.textContent = '翻訳エンジンの確認に失敗しました'
      console.error(err)
      return null
    }
    if (availability === 'unavailable') {
      status.textContent = `「${sourceLang}→日本語」の翻訳モデルが利用できません（言語を選び直してください）`
      return null
    }

    try {
      status.textContent =
        availability === 'available' ? '翻訳エンジンを準備中…' : '翻訳モデルをダウンロード中…'
      return await Translator.create({
        sourceLanguage: sourceLang,
        targetLanguage: TARGET_LANG,
        monitor(m) {
          m.addEventListener('downloadprogress', (e) => {
            const pct = Math.round(e.loaded * 100)
            status.textContent = `翻訳モデルをダウンロード中… ${pct}%`
            progressFill.style.setProperty('width', `${pct}%`, 'important')
          })
        },
      })
    } catch (err) {
      status.textContent = '翻訳エンジンの初期化に失敗しました'
      console.error(err)
      return null
    }
  }

  /**
   * 言語判定用に、ドキュメント本文の先頭サンプルテキストを取り出す。
   * @param {Document} doc 対象ドキュメント（左ペイン＝原文）
   * @returns {string} 空白を正規化した先頭1000文字
   */
  function sampleText(doc) {
    const t = (doc.body && doc.body.innerText) || ''
    return t.replace(/\s+/g, ' ').trim().slice(0, 1000)
  }

  /**
   * Chrome 内蔵の Language Detector API で原文の言語を判定する。
   * 「翻訳開始を押した瞬間」に判定できるよう、モデルDL済み（available）のときだけ使う。
   * 未DL・未対応・低確信・失敗時は null を返し、呼び出し側が手動選択/英語にフォールバックする。
   *
   * @param {string} sample 判定対象のサンプルテキスト
   * @returns {Promise<string|null>} 言語コード（基本サブタグ）または null
   */
  async function detectLanguage(sample) {
    if (typeof LanguageDetector === 'undefined' || !sample) return null
    try {
      const avail = await LanguageDetector.availability()
      if (avail !== 'available') return null
      const detector = await LanguageDetector.create()
      const results = await detector.detect(sample)
      if (typeof detector.destroy === 'function') detector.destroy()
      const top = results && results[0]
      if (!top || (top.confidence != null && top.confidence < 0.5)) return null
      // 'zh-Hant' 等は基本コードに丸める
      return String(top.detectedLanguage || '').split('-')[0] || null
    } catch (err) {
      console.error('言語判定に失敗:', err)
      return null
    }
  }

  /**
   * 言語コードを日本語の表示名に変換する。
   * 選択肢リストにあればその表示名、無ければ Intl.DisplayNames、それも無理ならコードをそのまま返す。
   * @param {string} code 言語コード（基本サブタグ）
   * @returns {string} 表示名
   */
  function langLabel(code) {
    const found = SOURCE_LANG_OPTIONS.find(([v]) => v === code)
    if (found) return found[1]
    try {
      return new Intl.DisplayNames(['ja'], { type: 'language' }).of(code) || code
    } catch {
      return code
    }
  }

  /**
   * 文字列を「文」単位のチャンク配列に分割する。
   * 終止記号（. ! ?）＋直後の閉じ括弧・引用符・空白までを1文として切り出す。
   * 連結すると元の文字列に戻る（空白も保持）。略語等による誤分割はベストエフォート。
   *
   * @param {string} text 分割対象の文字列
   * @returns {string[]} 文チャンクの配列
   */
  function splitIntoSentences(text) {
    const result = []
    let buf = ''
    let i = 0
    while (i < text.length) {
      const ch = text[i]
      buf += ch
      i++
      if (ch === '.' || ch === '!' || ch === '?') {
        // 連続する終止記号・閉じ括弧・引用符を取り込む
        while (i < text.length && /[.!?)'"’”]/.test(text[i])) buf += text[i++]
        // 直後の空白まで含めて文を区切る
        while (i < text.length && /\s/.test(text[i])) buf += text[i++]
        result.push(buf)
        buf = ''
      }
    }
    if (buf) result.push(buf)
    return result.length ? result : [text]
  }

  /**
   * ドキュメントを翻訳・ハイライトの単位の <span class="tv-sent" data-tv-sid> に変換する。
   * ブロック（<p> 等）ごとに配下テキストを連結し、`mode` に応じて区切る：
   * - 'sentence'（文単位）: 連結テキストを文に分割する
   * - 'block'（まとまり単位）: ブロック全体を1単位として扱う（文分割しない）
   * 区切った範囲を各テキストノードへ射影して span 化する。1単位が <a> 等の装飾をまたぐ場合は、
   * 複数の span に分割しつつ同一 sid を付与する（左ペインの装飾を保ったまま連動させるため）。
   * 各単位の先頭 span には完全英文を data-tv-src として持たせ、右ペインの翻訳に使う。
   *
   * 左右iframeは同一スナップショットなので、同じ走査順・同じ分割により sid が左右で一致する。
   * 前後の空白は span の外に出し、語間スペースの崩れを防ぐ。
   *
   * @param {Document} doc ラップ対象のドキュメント
   * @param {'sentence'|'block'} mode 翻訳・ハイライトの単位
   * @returns {void}
   */
  function wrapSentences(doc, mode) {
    let sid = 0
    for (const [, nodes] of groupTextNodesByBlock(doc)) {
      // ブロック内テキストを連結し、各ノードの開始位置を記録する
      let full = ''
      const map = []
      for (const node of nodes) {
        map.push({ node, start: full.length })
        full += node.nodeValue
      }
      if (!/[A-Za-z]/.test(full)) continue // 英字がなければ対象外

      // mode に応じて区切る（文単位は文分割、まとまり単位はブロック全体を1単位）
      const chunks = mode === 'block' ? [full] : splitIntoSentences(full)
      // 各区切りの [start, end)・sid・完全英文を決める
      const sentences = []
      let pos = 0
      for (const chunk of chunks) {
        const start = pos
        const end = pos + chunk.length
        pos = end
        const hasAlpha = /[A-Za-z]/.test(chunk)
        sentences.push({ start, end, sid: hasAlpha ? sid++ : null, text: chunk.trim(), attached: false })
      }

      // 各ノードを、重なる文範囲ごとに span／テキストへ分割して置換する
      for (const { node, start } of map) {
        if (!node.parentNode) continue
        const nodeText = node.nodeValue
        const nodeEnd = start + nodeText.length
        const frag = doc.createDocumentFragment()
        for (const sent of sentences) {
          // 文範囲とノード範囲の交差（グローバル座標）を取り、ノードローカルへ変換
          const from = Math.max(sent.start, start)
          const to = Math.min(sent.end, nodeEnd)
          if (from >= to) continue
          const piece = nodeText.slice(from - start, to - start)
          if (sent.sid != null && /[A-Za-z]/.test(piece)) {
            // 前後空白は span の外に出してハイライトのにじみを防ぐ
            const lead = piece.match(/^\s*/)[0]
            const trail = piece.match(/\s*$/)[0]
            const core = piece.slice(lead.length, piece.length - trail.length)
            if (lead) frag.appendChild(doc.createTextNode(lead))
            const span = doc.createElement('span')
            span.className = 'tv-sent'
            span.setAttribute('data-tv-sid', String(sent.sid))
            // その文の先頭 span にだけ完全英文を持たせる（右ペイン翻訳用）
            if (!sent.attached) {
              span.setAttribute('data-tv-src', sent.text)
              sent.attached = true
            }
            span.textContent = core
            frag.appendChild(span)
            if (trail) frag.appendChild(doc.createTextNode(trail))
          } else {
            frag.appendChild(doc.createTextNode(piece))
          }
        }
        node.parentNode.replaceChild(frag, node)
      }
    }
  }

  /**
   * 右iframe内の文 <span data-tv-sid> を Translator API で順に翻訳し、その場で上書きする。
   * 周囲のHTML/CSS/画像はそのまま残るため、レイアウト・画像を保ったまま訳文に置き換わる。
   * 同一英文は結果をキャッシュして翻訳呼び出しを節約する。
   *
   * @param {Document} rightDoc 右iframeのドキュメント
   * @param {Translator} translator 翻訳インスタンス
   * @param {HTMLElement} status 状態表示用の要素
   * @param {HTMLElement} progressFill 進捗バーの伸縮要素
   * @param {'sentence'|'block'} mode 翻訳単位（進捗表示の文言に使う）
   * @returns {Promise<void>}
   */
  async function translateSentences(rightDoc, translator, status, progressFill, mode) {
    const unit = mode === 'block' ? '段落' : '文'
    // 同一 sid の span（装飾またぎで複数に分かれることがある）を文書順にグループ化する
    const groups = new Map()
    for (const span of rightDoc.querySelectorAll('[data-tv-sid]')) {
      const sid = span.getAttribute('data-tv-sid')
      if (!groups.has(sid)) groups.set(sid, [])
      groups.get(sid).push(span)
    }
    const sids = Array.from(groups.keys())
    const cache = new Map()
    progressFill.style.setProperty('width', '0%', 'important')
    let done = 0

    await runPool(
      sids,
      async (sid) => {
        const spans = groups.get(sid)
        // 完全英文は先頭 span の data-tv-src に持たせてある（断片連結だと語間スペースが欠ける）
        const src = spans[0].getAttribute('data-tv-src') || spans.map((s) => s.textContent).join('')
        try {
          let translated = cache.get(src)
          if (translated == null) {
            translated = await translator.translate(src)
            cache.set(src, translated)
          }
          // 訳は先頭 span にまとめて入れ、残りの同 sid span は空にする（右はプレーン訳）
          spans[0].textContent = translated
          for (let k = 1; k < spans.length; k++) spans[k].textContent = ''
        } catch (err) {
          // 1単位の失敗は全体を止めない（原文のまま残す）
          console.error(`${unit}の翻訳に失敗:`, err)
        } finally {
          done++
          progressFill.style.setProperty('width', `${Math.round((done / sids.length) * 100)}%`, 'important')
          status.textContent = `翻訳中… ${done} / ${sids.length}`
        }
      },
      CONCURRENCY
    )

    status.textContent = `完了: ${sids.length} ${unit}を翻訳しました`
  }

  /**
   * テキストノード内の指定オフセット位置にある「英単語」を切り出す。
   * オフセットから左右へ英字・アポストロフィ・ハイフンの連なりを展開する。
   *
   * @param {string} text テキストノードの文字列
   * @param {number} offset カーソル直下の文字オフセット
   * @returns {string|null} 切り出した単語（英字を含まなければ null）
   */
  function extractWordAt(text, offset) {
    if (!text) return null
    const isWordChar = (ch) => /[A-Za-z'’-]/.test(ch)
    // offset がちょうど語末（直後が非単語）になることがあるため、必要なら1つ戻す
    let start = Math.min(offset, text.length)
    if (start > 0 && !isWordChar(text[start] || '') && isWordChar(text[start - 1])) start--
    let end = start
    while (start > 0 && isWordChar(text[start - 1])) start--
    while (end < text.length && isWordChar(text[end])) end++
    const word = text.slice(start, end).replace(/^[''-]+|[''-]+$/g, '')
    return /[A-Za-z]/.test(word) ? word : null
  }

  // 単語ホバー辞書セッション（Prompt API / Gemini Nano）。初回のみ生成して使い回す。
  let dictSessionPromise = null

  /**
   * 単語ホバー辞書用の Prompt API セッションを生成する。
   * Prompt API（LanguageModel）が無い／利用不可なら null（辞書なし＝機械翻訳のみにフォールバック）。
   * @returns {Promise<object|null>} セッション、または null
   */
  async function prepareDictSession() {
    if (typeof LanguageModel === 'undefined') return null
    try {
      const avail = await LanguageModel.availability()
      if (avail === 'unavailable') return null
      return await LanguageModel.create({
        initialPrompts: [{ role: 'system', content: DICT_SYSTEM_PROMPT }],
      })
    } catch (err) {
      console.error('辞書セッションの初期化に失敗:', err)
      return null
    }
  }

  /**
   * 辞書セッションを取得する（初回のみ生成し、以降は同じ Promise を返す）。
   * @returns {Promise<object|null>}
   */
  function getDictSession() {
    if (!dictSessionPromise) dictSessionPromise = prepareDictSession()
    return dictSessionPromise
  }

  /**
   * 左iframe（原文）で単語にマウスオーバーすると、訳と辞書をツールチップ表示する機能を有効化する。
   * まず Translator の機械翻訳を即表示し、原文が英語かつ Prompt API（Gemini Nano）が使える環境では
   * 辞書（品詞＋意味複数）を返り次第追記する2段階表示。英語以外・Prompt API 不可なら機械翻訳のみ。
   *
   * @param {Document} leftDoc 左iframeのドキュメント
   * @param {Translator} translator 流用する翻訳インスタンス
   * @param {string} sourceLang 翻訳元の言語（辞書は 'en' のときのみ有効）
   * @returns {void}
   */
  function enableWordHover(leftDoc, translator, sourceLang) {
    // 二重有効化を防ぐ（同一 leftDoc に複数回張らない）
    if (leftDoc.__tvWordHover) return
    leftDoc.__tvWordHover = true

    // ツールチップ用スタイルと要素を left iframe 内に注入する
    const style = leftDoc.createElement('style')
    style.textContent = WORD_TIP_STYLE
    ;(leftDoc.head || leftDoc.documentElement).appendChild(style)

    const tip = leftDoc.createElement('div')
    tip.className = 'tv-word-tip'
    leftDoc.body.appendChild(tip)

    // 機械翻訳・辞書を別々にキャッシュ（再ホバーを即時化）
    const mtCache = new Map()
    const dictCache = new Map()
    // Prompt API セッション（原文が英語のときだけ準備。null の間は機械翻訳のみ表示）
    let lmSession = null
    if (sourceLang === 'en') {
      getDictSession().then((s) => {
        lmSession = s
      })
    }

    // 現在カーソル下にある単語。非同期解決時に最新語と一致する時だけ反映する
    let currentWord = null
    let debounceTimer = 0
    let lastX = 0
    let lastY = 0

    /** ツールチップを隠す。 */
    function hideTip() {
      currentWord = null
      tip.classList.remove('tv-word-tip-show')
    }

    /**
     * 辞書1行の行頭にある品詞を「[略号] 」形式へ正規化する。
     * LLM出力が「動: 走る」「動詞 走る」「[動]走る」等とブレても [動] 走る に揃える。
     * 品詞が認識できなければ原文をそのまま返す。
     * @param {string} line 1行分のテキスト
     * @returns {string} 整形後の行
     */
    function formatDictLine(line) {
      const t = line.trim()
      const m = t.match(
        /^[[(（【]?\s*(動詞|名詞|形容詞|副詞|前置詞|接続詞|代名詞|助動詞|間投詞|感動詞|[動名形副前接代助間])\s*[\])）】]?\s*[:：.、]?\s*(.+)$/
      )
      return m ? `[${POS_ABBR[m[1]] || m[1]}] ${m[2].trim()}` : t
    }

    /**
     * ツールチップの内容を描画する（機械翻訳の見出し＋辞書 or 読み込み中）。
     * @param {string} word 原語
     * @param {string} mt 機械翻訳
     * @param {string|null} dictText 辞書テキスト（未取得は null）
     * @param {boolean} loading 辞書取得中か
     * @returns {void}
     */
    function renderTip(word, mt, dictText, loading) {
      tip.textContent = ''
      const head = leftDoc.createElement('div')
      head.className = 'tv-word-tip-head'
      const src = leftDoc.createElement('span')
      src.className = 'tv-word-tip-src'
      src.textContent = word
      const arrow = leftDoc.createElement('span')
      arrow.className = 'tv-word-tip-arrow'
      arrow.textContent = '→'
      head.append(src, arrow, leftDoc.createTextNode(mt || '—'))
      tip.appendChild(head)

      if (dictText) {
        const dict = leftDoc.createElement('div')
        dict.className = 'tv-word-tip-dict'
        for (const line of dictText.split('\n')) {
          const t = line.trim()
          if (!t) continue
          const row = leftDoc.createElement('div')
          row.className = 'tv-word-tip-row'
          row.textContent = formatDictLine(t)
          dict.appendChild(row)
        }
        if (dict.childNodes.length) tip.appendChild(dict)
      } else if (loading) {
        const ld = leftDoc.createElement('div')
        ld.className = 'tv-word-tip-loading'
        ld.textContent = '辞書を読み込み中…'
        tip.appendChild(ld)
      }
      tip.classList.add('tv-word-tip-show')
    }

    /**
     * ツールチップをカーソル近傍に配置する（画面端でクランプ）。
     * @param {number} x カーソルX（iframe内クライアント座標）
     * @param {number} y カーソルY
     * @returns {void}
     */
    function positionTip(x, y) {
      const margin = 12
      const vw = leftDoc.documentElement.clientWidth
      const vh = leftDoc.documentElement.clientHeight
      let left = x + 14
      let top = y + 16
      if (left + tip.offsetWidth + margin > vw) left = Math.max(margin, x - tip.offsetWidth - 14)
      if (top + tip.offsetHeight + margin > vh) top = Math.max(margin, y - tip.offsetHeight - 16)
      tip.style.left = `${left}px`
      tip.style.top = `${top}px`
    }

    /**
     * Prompt API で単語の辞書（品詞＋意味複数）を取得する。
     * @param {string} word 英単語
     * @returns {Promise<string>} 辞書テキスト（行区切り）
     */
    async function fetchDict(word) {
      const out = await lmSession.prompt(word)
      return (out || '').trim()
    }

    /**
     * カーソル位置の単語を解決し、機械翻訳を即表示してから辞書を追記する。
     * @param {number} x カーソルX
     * @param {number} y カーソルY
     * @returns {Promise<void>}
     */
    async function handleAt(x, y) {
      lastX = x
      lastY = y
      const range = leftDoc.caretRangeFromPoint(x, y)
      if (!range || range.startContainer.nodeType !== 3) {
        hideTip()
        return
      }
      const word = extractWordAt(range.startContainer.nodeValue, range.startOffset)
      if (!word) {
        hideTip()
        return
      }
      if (word === currentWord) {
        // 同じ単語上の移動：位置だけ追従させる
        if (tip.classList.contains('tv-word-tip-show')) positionTip(x, y)
        return
      }
      currentWord = word

      // 1) 機械翻訳を即表示（キャッシュ優先）
      let mt = mtCache.get(word)
      if (mt == null) {
        try {
          mt = await translator.translate(word)
        } catch (err) {
          console.error('単語の翻訳に失敗:', err)
          mt = ''
        }
        mtCache.set(word, mt)
      }
      // 機械翻訳待ちの間にカーソルが別語へ移っていたら反映しない
      if (currentWord !== word) return
      const cachedDict = dictCache.get(word)
      const wantDict = lmSession != null && cachedDict == null
      renderTip(word, mt, cachedDict || null, wantDict)
      positionTip(lastX, lastY)

      // 2) 辞書（Prompt API）が使えるなら取得して追記
      if (wantDict) {
        let dict
        try {
          dict = await fetchDict(word)
        } catch (err) {
          console.error('辞書の取得に失敗:', err)
          dict = ''
        }
        dictCache.set(word, dict)
        // 辞書待ちの間にカーソルが別語へ移っていたら反映しない
        if (currentWord === word) {
          renderTip(word, mt, dict || null, false)
          positionTip(lastX, lastY)
        }
      }
    }

    leftDoc.addEventListener('mousemove', (e) => {
      const x = e.clientX
      const y = e.clientY
      clearTimeout(debounceTimer)
      debounceTimer = setTimeout(() => handleAt(x, y), 120)
    })
    leftDoc.addEventListener('mouseleave', hideTip)
    leftDoc.addEventListener('scroll', hideTip, true)
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

  const { overlay, srcLang, granularity, translateBtn, status, progressFill, leftIframe, rightIframe, leftLoaded, rightLoaded } =
    buildOverlay(snapshotHtml)

  // 単語ホバー辞書で流用し、teardown で破棄するための translator 参照（言語が変わったら作り直す）
  let sharedTranslator = null
  let sharedTranslatorLang = null

  /**
   * 「自動判別」選択肢のラベルに判定結果を反映する（例: 自動判別（英語））。
   * code が null（判定不可）のときはフォールバック（英語）である旨を表示する。
   * @param {string|null} code 判定された言語コード、または null
   * @returns {void}
   */
  function updateAutoLabel(code) {
    const opt = srcLang.querySelector('option[value="auto"]')
    if (!opt) return
    opt.textContent = code ? `自動判別（${langLabel(code)}）` : '自動判別（判定不可→英語）'
  }

  /**
   * 翻訳元の言語を決定する。フィールドが「自動判別」のときは Language Detector で判定し、
   * 判定結果を言語フィールドのラベルに表示する。「押した瞬間」に判定できない（未DL等）場合は
   * 英語にフォールバックする。
   * @param {Document} leftDoc 原文側ドキュメント（判定のサンプル取得元）
   * @returns {Promise<string>} 翻訳元の言語コード
   */
  async function resolveSourceLang(leftDoc) {
    const sel = srcLang.value
    if (sel !== 'auto') return sel
    const detected = await detectLanguage(sampleText(leftDoc))
    updateAutoLabel(detected)
    return detected || DEFAULT_SOURCE_LANG
  }

  // 現在表示中のドキュメント（再翻訳の再ロードで差し替わる）
  let curLeftDoc = null
  let curRightDoc = null

  // --- ハイライト連動・スクロール同期のセットアップ（再ロードのたびに新docへ張り直す）---
  /**
   * 左右ドキュメントにハイライト連動・スクロール同期を張る。
   * ハイライト中の対応付けキー（{ attr, val }）は翻訳後は文 data-tv-sid、翻訳前は要素 data-tv-id。
   * @param {Document} leftDoc 左iframeのドキュメント
   * @param {Document} rightDoc 右iframeのドキュメント
   * @returns {void}
   */
  function setupSync(leftDoc, rightDoc) {
    let highlighted = null
    let isSyncing = false
    const docs = [leftDoc, rightDoc]

    /**
     * 現在ハイライト中の要素（左右両iframe）を消灯する。
     * @returns {void}
     */
    function clearHighlight() {
      if (!highlighted) return
      for (const doc of docs) {
        for (const el of doc.querySelectorAll(`[${highlighted.attr}="${highlighted.val}"]`)) {
          el.classList.remove('tv-hl')
        }
      }
      highlighted = null
    }

    /**
     * 指定属性・値に対応する要素を左右両iframeで点灯する。
     * 1文が装飾またぎで複数 span に分かれる場合があるため、全断片を同時に点灯する。
     * @param {string} attr 対応付けに使う属性（data-tv-sid / data-tv-id）
     * @param {string} val 属性値
     * @returns {void}
     */
    function applyHighlight(attr, val) {
      for (const doc of docs) {
        for (const el of doc.querySelectorAll(`[${attr}="${val}"]`)) {
          el.classList.add('tv-hl')
        }
      }
      highlighted = { attr, val }
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
     * カーソル位置から、ハイライトすべき対象を探す。
     * 翻訳後は文 <span class="tv-sent" data-tv-sid> を最小単位として最優先する。
     * 文spanの外（翻訳前や見出し外）では、テキストを持つ最も近い要素（data-tv-id）を対象にする。
     * 大きな div/section/body などラッパーは対象外にして「全体が光る」のを防ぐ。
     * @param {Element} start e.target
     * @returns {Element|null} ハイライト対象、なければ null
     */
    function findTextEl(start) {
      let cur = start
      while (cur && cur.getAttribute) {
        if (cur.classList && cur.classList.contains('tv-sent')) return cur
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
          clearHighlight()
          return
        }
        // 文spanなら sid、それ以外は要素IDで左右を対応付ける
        const sid = el.getAttribute('data-tv-sid')
        const attr = sid != null ? 'data-tv-sid' : 'data-tv-id'
        const val = sid != null ? sid : el.getAttribute('data-tv-id')
        if (highlighted && highlighted.attr === attr && highlighted.val === val) return
        clearHighlight()
        applyHighlight(attr, val)
      })
      doc.addEventListener('mouseleave', () => {
        clearHighlight()
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
  }

  // 初回ロード後：同期セットアップ＋翻訳前の要素ハイライトを有効化する
  Promise.all([leftLoaded, rightLoaded]).then(([leftDoc, rightDoc]) => {
    if (!leftDoc || !rightDoc) {
      status.textContent = 'このページは描画できませんでした（CSP制限の可能性）'
      return
    }
    curLeftDoc = leftDoc
    curRightDoc = rightDoc
    setupSync(leftDoc, rightDoc)
    // モデルDL済みなら、アイコンクリックの流れでそのまま自動翻訳を開始する
    maybeAutoTranslate()
  })

  // --- 翻訳開始ボタン（毎回スナップショットから作り直して翻訳。粒度を変えて再翻訳できる）---
  /**
   * 翻訳を実行する。既に翻訳済みの場合はスナップショットから両iframeを作り直してから翻訳するため、
   * 翻訳単位（文 / まとまり）を変えて何度でも再翻訳できる。translator は初回のみ生成して再利用する。
   * @returns {Promise<void>}
   */
  async function runTranslate() {
    const mode = granularity.value
    translateBtn.disabled = true
    granularity.disabled = true
    srcLang.disabled = true
    try {
      let leftDoc = curLeftDoc
      let rightDoc = curRightDoc
      if (!leftDoc || !rightDoc) {
        status.textContent = 'このページは描画できませんでした（CSP制限の可能性）'
        return
      }
      // 再ロードで先頭に戻らないよう、読んでいた位置（左ペインのスクロール率）を保持する
      let scrollRatio = null
      // 既に翻訳済み（span化済み）なら、スナップショットから作り直して粒度・言語変更や再翻訳に備える
      if (rightDoc.querySelector('[data-tv-sid]')) {
        // 再ロード前に左ペインのスクロール率を記録（左は原文なので再ロード後も高さがほぼ一致する）
        const se = leftDoc.scrollingElement
        if (se) {
          const max = se.scrollHeight - se.clientHeight
          scrollRatio = max > 0 ? se.scrollTop / max : 0
        }
        status.textContent = '再読み込み中…'
        progressFill.style.setProperty('width', '0%', 'important')
        const lp = waitSnapshotLoad(leftIframe)
        const rp = waitSnapshotLoad(rightIframe)
        leftIframe.srcdoc = snapshotHtml
        rightIframe.srcdoc = snapshotHtml
        ;[leftDoc, rightDoc] = await Promise.all([lp, rp])
        curLeftDoc = leftDoc
        curRightDoc = rightDoc
        setupSync(leftDoc, rightDoc)
        // 翻訳完了を待たず、再ロード直後に読んでいた位置へ即復元する
        restoreScroll(leftDoc, scrollRatio)
      }
      // 翻訳元の言語を決定（自動判別 or 手動選択。自動が不可なら英語フォールバック）
      const sourceLang = await resolveSourceLang(leftDoc)
      if (sourceLang === TARGET_LANG) {
        status.textContent = 'このページは日本語と判定されました（翻訳元の言語を選び直してください）'
        return
      }
      // 言語が変わったら translator を作り直す（初回 or 言語切替時のみ生成）
      if (!sharedTranslator || sharedTranslatorLang !== sourceLang) {
        if (sharedTranslator && typeof sharedTranslator.destroy === 'function') sharedTranslator.destroy()
        sharedTranslator = await prepareTranslator(sourceLang, status, progressFill)
        sharedTranslatorLang = sourceLang
        if (!sharedTranslator) return
      }
      // 左右を選択粒度の <span data-tv-sid> にラップ（同一スナップショット＋同一分割で sid 一致）
      wrapSentences(leftDoc, mode)
      wrapSentences(rightDoc, mode)
      // 右ペインを翻訳し、左ペインに単語ホバー辞書を有効化する（辞書は英語原文時のみ）
      await translateSentences(rightDoc, sharedTranslator, status, progressFill, mode)
      enableWordHover(leftDoc, sharedTranslator, sourceLang)
    } finally {
      // 粒度・言語を変えて再翻訳できるよう操作を再有効化する
      translateBtn.disabled = false
      granularity.disabled = false
      srcLang.disabled = false
    }
  }
  translateBtn.addEventListener('click', runTranslate)

  /**
   * アイコンクリック直後の自動翻訳。翻訳モデルが取得済み（available）のときだけ自動で翻訳を走らせる。
   * 未取得（downloadable/downloading）の初回は、モデルDLにユーザー操作が必要なため自動実行せず、
   * 「翻訳開始」ボタンを押してもらう旨を表示する（ボタン押下を起点に確実にDLさせる）。
   * @returns {Promise<void>}
   */
  async function maybeAutoTranslate() {
    if (typeof Translator === 'undefined') {
      status.textContent = 'このブラウザは内蔵翻訳に未対応です（Chrome 138以降のデスクトップ版が必要）'
      return
    }
    const leftDoc = curLeftDoc
    if (!leftDoc) return
    // 翻訳元の言語を決定（自動判別は「押した瞬間」に判定できる場合のみ。不可なら英語フォールバック）
    const sourceLang = await resolveSourceLang(leftDoc)
    if (sourceLang === TARGET_LANG) {
      status.textContent = 'このページは日本語と判定されました（翻訳元の言語を選び直してください）'
      return
    }
    let availability
    try {
      availability = await Translator.availability({
        sourceLanguage: sourceLang,
        targetLanguage: TARGET_LANG,
      })
    } catch (err) {
      // 確認に失敗した場合はボタン操作に委ねる
      console.error(err)
      return
    }
    if (availability === 'available') {
      // モデルDL不要のため、ユーザー操作なしでそのまま翻訳できる
      runTranslate()
    } else if (availability === 'unavailable') {
      status.textContent = `「${sourceLang}→日本語」の翻訳モデルが利用できません（言語を選び直してください）`
    } else {
      // downloadable / downloading：初回DLにはユーザー操作が要るためボタンを促す
      status.textContent = '「翻訳開始」を押すと翻訳モデルをダウンロードして翻訳します'
    }
  }

  // --- Esc キーで閉じる ---
  function onKeydown(e) {
    if (e.key === 'Escape') window.__translateAddonTeardown()
  }
  document.addEventListener('keydown', onKeydown, true)

  // --- teardown（原状復帰）---
  window.__translateAddonTeardown = () => {
    document.removeEventListener('keydown', onKeydown, true)
    if (sharedTranslator && typeof sharedTranslator.destroy === 'function') {
      sharedTranslator.destroy()
      sharedTranslator = null
    }
    if (dictSessionPromise) {
      dictSessionPromise.then((s) => {
        if (s && typeof s.destroy === 'function') s.destroy()
      })
      dictSessionPromise = null
    }
    overlay.remove()
    document.documentElement.style.overflow = prevHtmlOverflow
    window.__translateAddonActive = false
    delete window.__translateAddonTeardown
  }
})()
