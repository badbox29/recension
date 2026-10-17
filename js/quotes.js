/**
 * ============================================================
 * quotes.js — typographic quotes, one set of rules
 * ============================================================
 *
 * Two jobs share one decision procedure:
 *
 *   curlText(text)   fix a whole scene, with a report
 *   quoteFor(...)    decide a single character as it is typed
 *
 * They cannot be literally the same function — the fixer can see what
 * comes after a quote and the live handler cannot, because it hasn't
 * been written yet. What IS shared is every rule about what a quote
 * means in context, so the two can't drift into disagreeing.
 *
 * ── CONVENTION ──────────────────────────────────────────────
 * American usage: double quotes outside, single inside. That is what
 * standard manuscript format expects, and what this app compiles to.
 * A single quote opening at the outer level is flagged rather than
 * rewritten — it may be deliberate, and silently renesting someone's
 * dialogue is not a repair.
 *
 * ── NORMALISE, THEN DECIDE ──────────────────────────────────
 * Text typed across several devices contains straight quotes, correct
 * curly quotes, and curly quotes facing the wrong way. Detecting "this
 * one is backwards" is harder and less reliable than flattening
 * everything to straight and deciding again from scratch. The cost is
 * that a deliberately-placed curly character gets re-decided, which is
 * why the fixer previews before it writes.
 *
 * ── WHAT IS NEVER TOUCHED ───────────────────────────────────
 * Code fences, inline code, URLs, markdown link targets, wikilinks and
 * HTML tags are masked before processing and restored after. An
 * apostrophe inside a URL is part of the address, not prose.
 */

const Quotes = (() => {

  const LDQUO = '\u201C', RDQUO = '\u201D';
  const LSQUO = '\u2018', RSQUO = '\u2019';

  /**
   * Words that legitimately begin with an apostrophe, where the mark
   * stands for dropped letters rather than opening a quotation.
   *
   * A list is unavoidable: the app sees an apostrophe followed by
   * letters, and that is identical in "’em laughed" and "‘em dashes
   * are tricky,’ she said". Only meaning separates them.
   */
  const ELISIONS = [
    'em', 'til', 'till', 'cause', 'round', 'bout', 'nother', 'fore',
    'gainst', 'neath', 'tween', 'tis', 'twas', 'twere', 'twould',
    'n', 'sup', 'murica', 'specially', 'scuse', 'spose', 'cept',
    'fraid', 'course', 'nuff', 'kay', 'lo', 'pon', 'ere', 'ope',
    'dors',
  ];

  /**
   * opensHere(before) — does a quote at this position open or close?
   *
   * The rule is about WHITESPACE, not punctuation. An earlier version
   * treated a dash or an ellipsis as opening context, which is wrong
   * in the commonest line in any novel:
   *
   *     "Eddie, I—"      the last quote CLOSES
   *     "goes…"          so does this one
   *
   * A dash only opens when the dash itself begins a phrase — "He said
   * —“Go.”" — so it has to look past the dash at what precedes it.
   */
  function opensHere(before) {
    if (!before) return true;
    const last = before.slice(-1);
    if (/\s/.test(last)) return true;
    if (/[([{]/.test(last)) return true;
    if (last === LDQUO || last === LSQUO) return true;

    // A lead-in dash, and only a lead-in dash.
    if (last === '\u2014' || last === '\u2013' || last === '-') {
      const rest = before.slice(0, -1).replace(/[\u2014\u2013-]+$/, '');
      return rest === '' || /\s$/.test(rest);
    }

    // Everything else — a letter, a comma, a full stop, an ellipsis,
    // a closing bracket — means this quote closes something.
    return false;
  }

  const WORD = /[A-Za-z0-9\u00C0-\u024F]/;

  // ── Masking ──────────────────────────────────────────────────────

  // Order matters: fenced blocks first, so a stray backtick inside one
  // can't start an inline span.
  const MASKS = [
    /```[\s\S]*?```/g,          // fenced code
    /`[^`\n]*`/g,               // inline code
    // Only the TARGET of a wikilink is masked. The display text after
    // the pipe is prose the reader sees, and its apostrophes should
    // curl like any other — but the target has to stay byte-identical
    // or it stops matching the card.
    /\[\[[^\]|]*/g,
    /\]\([^)\s]*\)/g,           // markdown link targets
    /<[^>\n]+>/g,               // html tags
    /\b(?:https?:\/\/|www\.)\S+/gi,   // bare urls
  ];

  function mask(text) {
    const kept = [];
    let out = text;
    for (const re of MASKS) {
      out = out.replace(re, m => {
        // \u0000 cannot appear in real prose, so the placeholder can
        // never collide with the text being processed.
        kept.push(m);
        return `\u0000${kept.length - 1}\u0000`;
      });
    }
    return { out, kept };
  }

  function unmask(text, kept) {
    return text.replace(/\u0000(\d+)\u0000/g, (_m, i) => kept[Number(i)]);
  }

  // ── The decision ─────────────────────────────────────────────────

  /**
   * quoteFor(ch, before, after) → { ch, flag }
   *
   * `before` is the character to the left, `after` the one to the
   * right — empty string where there is none. `after` is unavailable
   * while typing, and the rules are arranged so its absence only
   * affects cases that are already ambiguous.
   */
  /**
   * quoteFor(ch, before, after, word, closesLater)
   *
   * `before` is everything to the left on this line — not one
   * character, because a lead-in dash has to be told apart from a
   * trailing one. `closesLater` is whether a matching single quote
   * appears before the end of the paragraph; the fixer can answer
   * that and live typing cannot, which is the whole difference
   * between them.
   */
  function quoteFor(ch, before, after, word = '', closesLater = false) {
    if (ch === '"') {
      return { ch: opensHere(before) ? LDQUO : RDQUO };
    }

    const prev = before.slice(-1);

    // Inside a word: don’t, Eddie’s, y’know. Always an apostrophe.
    if (WORD.test(prev) && WORD.test(after)) return { ch: RSQUO };

    // After a word: a possessive plural (the boys’) or a closing
    // single quote. Identical glyph, so nothing to decide.
    if (WORD.test(prev)) return { ch: RSQUO };

    if (opensHere(before)) {
      // A two-digit year is never a quotation: ’84, ’90s.
      if (/[0-9]/.test(after)) return { ch: RSQUO };

      // Known dropped letters.
      if (word && ELISIONS.includes(word.toLowerCase())) return { ch: RSQUO };

      // Otherwise it opens a quotation only if something closes it
      // later in the same paragraph. ‘Six’ does; ’dors does not.
      if (WORD.test(after)) {
        return closesLater ? { ch: LSQUO } : { ch: RSQUO, flag: 'single-open' };
      }

      return { ch: LSQUO, flag: 'lone-single' };
    }

    return { ch: RSQUO };
  }

  /**
   * closesLater(text, i) — is there a matching single quote before the
   * end of this paragraph?
   *
   * This is what separates ‘Six’ from ’dors without a word list.
   * A quotation has a close; a dropped letter does not. Only the
   * fixer can ask it — while typing, the rest of the sentence does
   * not exist yet.
   */
  function closesLater(text, i) {
    const end = text.indexOf('\n\n', i);
    const stop = end === -1 ? text.length : end;
    for (let k = i + 1; k < stop; k++) {
      if (text[k] !== "'") continue;
      // A closing single follows a non-space: Six' rather than 'Six.
      if (!/\s/.test(text[k - 1] || ' ')) return true;
    }
    return false;
  }

  // The word following an apostrophe, for the elision check.
  function wordAfter(text, i) {
    const m = text.slice(i + 1).match(/^[A-Za-z\u00C0-\u024F]+/);
    return m ? m[0] : '';
  }

  // ── The fixer ────────────────────────────────────────────────────

  /**
   * curlText(text) → { text, changes, flags }
   *
   * `flags` are positions worth a human look: an unmatched double
   * quote, or a leading apostrophe that might be an elision this list
   * doesn't know. Nothing is silently left wrong — flagged characters
   * still get the best guess, so the result is always usable.
   */
  function curlText(text) {
    if (!text) return { text: text || '', changes: 0, flags: [] };

    const { out, kept } = mask(text);

    // Flatten first. Deciding afresh beats trying to recognise a
    // backwards curly quote.
    const flat = out
      .replace(/[\u201C\u201D\u201E\u201F]/g, '"')
      .replace(/[\u2018\u2019\u201A\u201B]/g, "'");

    let result = '';
    let changes = 0;
    const flags = [];
    let openDoubles = 0;
    let lineNo = 1;

    for (let i = 0; i < flat.length; i++) {
      const c = flat[i];
      if (c === '\n') { lineNo++; result += c; continue; }

      if (c !== '"' && c !== "'") { result += c; continue; }

      // The left-hand side AS ALREADY CONVERTED, not as typed. A quote
      // directly after an opening “ opens too — and in the flattened
      // text that “ is still a straight quote, which reads as closing
      // context and got ‘Six’ wrong.
      const lineStart = result.lastIndexOf('\n') + 1;
      const before = result.slice(lineStart);
      const after = i < flat.length - 1 ? flat[i + 1] : '';
      const { ch, flag } = quoteFor(
        c, before, after,
        c === "'" ? wordAfter(flat, i) : '',
        c === "'" ? closesLater(flat, i) : false);

      if (c === '"') {
        if (ch === LDQUO) {
          // Dialogue running over a paragraph break opens every
          // paragraph and closes only at the end. An opening quote at
          // the start of a paragraph while one is already open is that
          // convention, not a second speaker — counting it would
          // report a perfectly correct passage as unbalanced.
          if (!(openDoubles > 0 && atParagraphStart(flat, i))) openDoubles++;
        } else {
          openDoubles = Math.max(0, openDoubles - 1);
        }
      }

      if (flag) flags.push({ line: lineNo, kind: flag, near: context(flat, i) });

      result += ch;
      if (ch !== out[i]) changes++;
    }

    if (openDoubles > 0) {
      flags.push({ line: lineNo, kind: 'unclosed-double',
                   near: `${openDoubles} opening quote${openDoubles === 1 ? '' : 's'} never closed` });
    }

    const final = unmask(result, kept);
    // Count against the ORIGINAL, so re-running on fixed text reports
    // nothing rather than reporting the same work twice.
    return { text: final, changes: final === text ? 0 : countDiff(text, final), flags };
  }

  // Nothing but whitespace between this position and a line break.
  function atParagraphStart(text, i) {
    for (let k = i - 1; k >= 0; k--) {
      const c = text[k];
      if (c === '\n') return true;
      if (!/\s/.test(c)) return false;
    }
    return true;
  }

  function countDiff(a, b) {
    let n = 0;
    const len = Math.min(a.length, b.length);
    for (let i = 0; i < len; i++) if (a[i] !== b[i]) n++;
    return n + Math.abs(a.length - b.length);
  }

  function context(text, i, width = 32) {
    const from = Math.max(0, i - width / 2);
    const to = Math.min(text.length, i + width / 2);
    return (from > 0 ? '…' : '') + text.slice(from, to).replace(/\n/g, ' ')
         + (to < text.length ? '…' : '');
  }

  // ── Live input ───────────────────────────────────────────────────

  /**
   * typed(ch, before) → the character to insert.
   *
   * Only the text to the left is known. Every rule that needs to see
   * ahead degrades to the commoner reading, and the fixer is what
   * catches the rest.
   */
  function typed(ch, before) {
    // Shares opensHere() with the fixer. It used to carry its own copy
    // of the rule, and when the fixer's was rewritten this was left
    // referring to something that no longer existed — which broke the
    // double-quote key outright.
    if (ch === '"') return opensHere(before) ? LDQUO : RDQUO;

    if (ch === "'") {
      // After a letter or digit it is an apostrophe or a closing
      // single — the same glyph either way, so this is always right.
      if (WORD.test(before.slice(-1))) return RSQUO;
      // At a word start it could be an elision or a nested quote, and
      // what follows has not been typed yet. Opening is the commoner
      // case mid-dialogue; Fix Quotes settles the rest.
      return opensHere(before) ? LSQUO : RSQUO;
    }
    return ch;
  }

  /**
   * checkQuotes(text) → [{ line, kind, near }]
   *
   * Report only. Counts “ and ” per paragraph and names the ones that
   * don't balance, with the one exception that matters in fiction:
   *
   *   Dialogue running over a paragraph break legitimately opens with
   *   “ and never closes, because the speech continues. That is only
   *   correct if the NEXT paragraph also opens with “ — otherwise the
   *   quote really is unclosed, and the difference is invisible to
   *   read past.
   *
   * Nothing here is fixed automatically. An unbalanced quote is a
   * question about what you meant, not a typo with one right answer.
   */
  function checkQuotes(text) {
    if (!text) return [];
    const { out } = mask(text);
    const paras = out.split(/\n{2,}/);
    const flags = [];

    // Line number of each paragraph's first line.
    let line = 1;
    const lineOf = paras.map(p => {
      const at = line;
      line += p.split('\n').length + 1;
      return at;
    });

    const opensWith = p => /^\s*[\u201C"]/.test(p);

    paras.forEach((p, i) => {
      const opens = (p.match(/\u201C/g) || []).length;
      const closes = (p.match(/\u201D/g) || []).length;
      if (opens === closes) return;

      if (opens === closes + 1) {
        // One unclosed quote — valid only if the speech carries on.
        const next = paras[i + 1];
        if (next !== undefined && opensWith(next)) return;
        flags.push({ line: lineOf[i], kind: 'unclosed-double', near: snippet(p) });
        return;
      }

      if (closes > opens) {
        flags.push({ line: lineOf[i], kind: 'stray-close', near: snippet(p) });
        return;
      }

      flags.push({ line: lineOf[i], kind: 'unbalanced', near: snippet(p) });
    });

    return flags;
  }

  function snippet(p, width = 64) {
    const one = p.replace(/\s+/g, ' ').trim();
    return one.length > width ? one.slice(0, width) + '…' : one;
  }

  // ══ Spacing ══════════════════════════════════════════════════════
  //
  // The same class of problem as mixed quotes, from the same cause:
  // text assembled on several devices. Invisible by definition, which
  // is why it needs a tool rather than an eye.
  //
  // The job is narrower than "collapse runs of spaces", because some
  // runs are load-bearing:
  //
  //   A line ending in exactly two spaces is a MARKDOWN HARD BREAK.
  //   Collapsing it silently rewrites the structure of the text. This
  //   writer doesn't use them, but the tool shouldn't assume that.
  //
  //   Leading spaces are indentation — lists, code, verse.
  //
  // So only runs BETWEEN non-space characters, mid-line, are touched.

  const NBSP = '\u00A0';

  /**
   * tidySpacing(text) → { text, changes, counts }
   *
   * counts breaks the work down by kind, because "112 changes" tells
   * you nothing about whether to trust it and "98 double spaces, 14
   * non-breaking spaces" tells you everything.
   */
  function tidySpacing(text) {
    if (!text) return { text: text || '', changes: 0, counts: {} };

    const { out, kept } = mask(text);
    const counts = { doubles: 0, nbsp: 0, trailing: 0, blanks: 0, prePunct: 0 };

    const lines = out.split('\n');
    const fixed = lines.map((line, idx) => {
      let l = line;

      // Non-breaking spaces, from pasting out of a browser or Word.
      // Identical to look at, and they quietly break search.
      const nb = (l.match(new RegExp(NBSP, 'g')) || []).length;
      if (nb) { counts.nbsp += nb; l = l.split(NBSP).join(' '); }

      // A hard break is exactly two trailing spaces AND a line of text
      // after it. Two spaces at the end of a paragraph break nothing —
      // there is no following line to break onto — so they are just
      // stray whitespace. Tabs and runs of three or more are never a
      // hard break.
      const next = lines[idx + 1];
      const hard = / {2}$/.test(l) && !/ {3}$|\t$/.test(l)
                   && next !== undefined && next.trim() !== '';
      const body0 = l.replace(/\s+$/, '');
      const trailing = l.length - body0.length;
      if (trailing && !hard) counts.trailing++;

      // Only between two non-space characters, so indentation survives.
      let body = body0.replace(/(\S) {2,}(?=\S)/g, (m, c) => {
        counts.doubles++;
        return c + ' ';
      });

      // " ," and " ." — an artefact of editing on a phone.
      body = body.replace(/\s+([,.;:!?])/g, (m, p) => {
        counts.prePunct++;
        return p;
      });

      return hard ? body + '  ' : body;
    });

    // Three or more blank lines are never meaningful; one blank line
    // is the paragraph break.
    let joined = fixed.join('\n').replace(/\n{3,}/g, m => {
      counts.blanks++;
      return '\n\n';
    });

    const final = unmask(joined, kept);
    const changes = Object.values(counts).reduce((a, b) => a + b, 0);
    return { text: final, changes: final === text ? 0 : changes, counts };
  }

  return {
    curlText, quoteFor, typed, mask, unmask, tidySpacing, checkQuotes,
    ELISIONS, LDQUO, RDQUO, LSQUO, RSQUO,
  };
})();

if (typeof module !== 'undefined') module.exports = Quotes;

/**
 * ============================================================
 * diff.js — word-level difference, for snapshot comparison
 * ============================================================
 *
 * Lives here rather than in its own file because it is small and
 * shares the same job: looking at two pieces of prose and saying what
 * is different about them.
 *
 * Word-level, not character-level. A character diff of edited prose
 * produces confetti — half-highlighted words that are harder to read
 * than the original. A writer wants to see which WORDS changed.
 */
const Diff = (() => {

  // Words and the whitespace between them, kept as separate tokens so
  // the text can be reassembled exactly.
  function tokenise(text) {
    return (text || '').match(/\s+|[^\s]+/g) || [];
  }

  /**
   * words(before, after) → [{ type, text }]
   *
   * type is 'same', 'added' or 'removed'.
   *
   * A straight longest-common-subsequence over tokens. Quadratic, and
   * that is fine: this compares one scene against one earlier version
   * of itself, so a few thousand tokens at most, on a gesture the
   * reader initiated.
   */
  function words(before, after) {
    const a = tokenise(before), b = tokenise(after);

    // Trim the shared head and tail first. Edits to prose are almost
    // always local, so this usually leaves a handful of tokens for the
    // expensive part to chew on.
    let head = 0;
    while (head < a.length && head < b.length && a[head] === b[head]) head++;
    let tail = 0;
    while (tail < a.length - head && tail < b.length - head &&
           a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;

    const midA = a.slice(head, a.length - tail);
    const midB = b.slice(head, b.length - tail);

    const out = [];
    const push = (type, text) => {
      if (!text) return;
      const last = out[out.length - 1];
      if (last && last.type === type) last.text += text;
      else out.push({ type, text });
    };

    push('same', a.slice(0, head).join(''));

    // LCS table over the differing middle.
    const n = midA.length, m = midB.length;
    if (n && m) {
      const lcs = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
      for (let i = n - 1; i >= 0; i--) {
        for (let j = m - 1; j >= 0; j--) {
          lcs[i][j] = midA[i] === midB[j]
            ? lcs[i + 1][j + 1] + 1
            : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
        }
      }
      let i = 0, j = 0;
      while (i < n && j < m) {
        if (midA[i] === midB[j]) { push('same', midA[i]); i++; j++; }
        else if (lcs[i + 1][j] >= lcs[i][j + 1]) { push('removed', midA[i]); i++; }
        else { push('added', midB[j]); j++; }
      }
      while (i < n) { push('removed', midA[i]); i++; }
      while (j < m) { push('added', midB[j]); j++; }
    } else {
      push('removed', midA.join(''));
      push('added', midB.join(''));
    }

    push('same', a.slice(a.length - tail).join(''));
    return out;
  }

  // A one-line summary: how much moved, without reading the diff.
  function summary(before, after) {
    let added = 0, removed = 0;
    for (const part of words(before, after)) {
      const n = (part.text.match(/[^\s]+/g) || []).length;
      if (part.type === 'added') added += n;
      if (part.type === 'removed') removed += n;
    }
    return { added, removed };
  }

  return { words, summary, tokenise };
})();

if (typeof module !== 'undefined') module.exports.Diff = Diff;
