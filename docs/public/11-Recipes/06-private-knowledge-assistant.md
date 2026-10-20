# Private knowledge assistant

Answer questions from an authorized, revision-aware corpus and recheck access when source visibility changes.

Declare which records or files may enter the corpus, who may ask about them and which revisions are eligible. Indexing is not authorization: every answer must be grounded only in sources currently readable by the caller. Return source evidence with the answer so a person can check the basis.

When a source changes, is withdrawn or becomes private, update its corpus eligibility and prevent stale indexed content from being served as current. Recheck access at answer time; cached retrieval must not preserve access after revocation. If indexing coverage is incomplete or evidence cannot support an answer, say so rather than inventing a response.

Keep the model's generated text distinct from source facts. Do not expose snippets, titles or existence of inaccessible records through citations or errors. Test users with different source scopes, revoked access, outdated revisions, incomplete indexing and unsupported questions.

This recipe requires the app's corpus capability and runtime model binding; it is not a general unrestricted chatbot. See [knowledge corpora](../07-Integrations/09-knowledge-corpora.md), [read policies](../04-Access-and-rules/03-read-policies-and-field-access.md) and [text generation](../07-Integrations/07-text-and-image-generation.md).
