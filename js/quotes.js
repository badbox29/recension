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
  ];

  // Opening a quote is natural after these: nothing at all, a space, an
  // opening bracket, a dash, or an ellipsis. Anything else means the
  // quote is closing something.
  const OPENS_AFTER = /[\s(\[{\u2014\u2013\u2026\u201C\u2018<]/;

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
  function quoteFor(ch, before, after, word = '') {
    if (ch === '"') {
      const opening = before === '' || OPENS_AFTER.test(before);
      return { ch: opening ? LDQUO : RDQUO };
    }

    // An apostrophe inside a word is always an apostrophe: don’t,
    // Eddie’s, y’know, nobody’d.
    if (WORD.test(before) && WORD.test(after)) return { ch: RSQUO };

    // After a word with nothing word-like following: a possessive
    // plural (the boys’) or a closing single quote. Both are the same
    // glyph, so there is nothing to decide.
    if (WORD.test(before)) return { ch: RSQUO };

    // At the start of a word.
    if (before === '' || OPENS_AFTER.test(before)) {
      // Digits are unambiguous: ’84, ’90s.
      if (/[0-9]/.test(after)) return { ch: RSQUO };

      if (word && ELISIONS.includes(word.toLowerCase())) return { ch: RSQUO };

      // Opening a nested single quote — correct in American usage
      // inside dialogue, and the right default here. Flagged because
      // the alternative is an unlisted elision, and only you can tell.
      if (WORD.test(after)) return { ch: LSQUO, flag: 'single-open' };

      return { ch: LSQUO, flag: 'lone-single' };
    }

    return { ch: RSQUO };
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

      const before = i > 0 ? flat[i - 1] : '';
      const after = i < flat.length - 1 ? flat[i + 1] : '';
      const { ch, flag } = quoteFor(c, before, after, c === "'" ? wordAfter(flat, i) : '');

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
    if (ch === '"') {
      return (before === '' || OPENS_AFTER.test(before)) ? LDQUO : RDQUO;
    }
    if (ch === "'") {
      // After a letter or digit it is an apostrophe or a closing
      // single — the same glyph either way, so this is always right.
      if (WORD.test(before)) return RSQUO;
      // At a word start it could be an elision or a nested quote, and
      // what follows has not been typed. Opening is the commoner case
      // mid-dialogue; Fix Quotes settles the rest.
      return LSQUO;
    }
    return ch;
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
    const fixed = lines.map(line => {
      let l = line;

      // Non-breaking spaces, from pasting out of a browser or Word.
      // Identical to look at, and they quietly break search.
      const nb = (l.match(new RegExp(NBSP, 'g')) || []).length;
      if (nb) { counts.nbsp += nb; l = l.split(NBSP).join(' '); }

      // A hard break is exactly two trailing spaces. Keep those,
      // normalise anything else at the end of the line.
      const hard = /\S {2}$/.test(l);
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
    curlText, quoteFor, typed, mask, unmask, tidySpacing,
    ELISIONS, LDQUO, RDQUO, LSQUO, RSQUO,
  };
})();

if (typeof module !== 'undefined') module.exports = Quotes;
