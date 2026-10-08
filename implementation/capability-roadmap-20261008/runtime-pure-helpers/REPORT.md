# Existing pure helper exports

Commit `b5f3f61c` exposes existing Values `int64`, `datetime`, and `compareInstant` through the Cloudflare runtime stdlib. The production change is one direct export statement. The selected private build and four focused tests passed; generated caller-text date-time controls also passed.

The broader unchanged stdlib suite retained eight baseline policy-disagreement failures. The separate numeric handler still rejected stored wire count `"1"`, so field hydration remains a later change. Existing void-result replay and broader runtime scopes were not resolved. No constructors, codecs, or algorithms were added; the date-time fixture and generated artifact remain reusable.
