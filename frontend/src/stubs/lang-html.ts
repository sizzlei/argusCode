// Build-time replacement for @codemirror/lang-html (see vite.config.ts).
//
// @codemirror/lang-markdown imports lang-html to highlight raw HTML inside
// Markdown, which also pulls in the JavaScript and CSS parsers (~40% of the
// bundle). ArgusCode does not need HTML highlighting in Markdown, so this
// stub provides the same API with a parser that produces an empty tree.
import { defineLanguageFacet, Language, LanguageSupport } from '@codemirror/language';
import { Input, NodeType, Parser, PartialParse, Tree, TreeFragment } from '@lezer/common';

class NullParser extends Parser {
  createParse(
    input: Input,
    _fragments: readonly TreeFragment[],
    ranges: readonly { from: number; to: number }[],
  ): PartialParse {
    const from = ranges.length ? ranges[0].from : 0;
    const to = ranges.length ? ranges[ranges.length - 1].to : input.length;
    return {
      parsedPos: to,
      stoppedAt: null,
      stopAt() {},
      advance: () => new Tree(NodeType.none, [], [], to - from),
    };
  }
}

const htmlLanguage = new Language(defineLanguageFacet(), new NullParser(), [], 'html');

export function html(_config?: unknown): LanguageSupport {
  return new LanguageSupport(htmlLanguage);
}

export function htmlCompletionSource(_context?: unknown) {
  return { from: 0, options: [] };
}

export { htmlLanguage };
