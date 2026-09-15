# The tool lives in its own public repository, free of employer references

The idea, the articles and the vendored reference trees (some without a licence) live in a private workshop folder. The tool itself is a separate public repository, MIT, cloned as a sibling of the workshop. Nothing in it names an employer, its repositories or its internal tooling: repo-specific behaviour is configuration on my machine, never a mention in code or docs. Going public later would mean rewriting history, so it is public from the first commit.

## Considered options

- Nesting the tool in the workshop as a subtree: rejected. Subtrees here are read-only vendoring by convention, and pushing development back out through `git subtree push` is friction on every change.
- Nesting it as a submodule: rejected. Every push needs a second commit to pin the workshop, and two lanes of tooling end up tangled in one tree.
