# jcs-canonicalizer

An offline executable tool to canonicalize JSON according to the JSON Canonicalization Scheme (JCS) RFC 8785, with strict UTF-16 sorting, lone surrogate validation, and recursive array sorting.

## Requested task

an offline executable tool to canonicalize JSON according to the JSON Canonicalization Scheme (JCS) RFC 8785

## Independent review

The implementation correctly handles basic key sorting, string escaping, and negative zero. However, it has several critical gaps regarding RFC 8785: 1) It does not throw an error on invalid Unicode data like lone surrogates (e.g., U+DEAD), which is a strict requirement of Section 3.2.2.2. 2) It does not recursively sort objects nested inside arrays (Section 3.2.3). 3) It does not handle standard JSON serialization of objects with a custom toJSON() method or other non-plain objects correctly. The adversarial tests will target these gaps, specifically lone surrogates, nested objects inside arrays, and complex sorting scenarios.
## Independent verification evidence

- [RFC 8785](https://www.rfc-editor.org/rfc/rfc8785.txt)

This generated tool is executed only inside a network-denied Vercel Sandbox. Passing generated tests is not a certification; the draft still requires human review.
