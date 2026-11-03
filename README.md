# WP Git Deploy actions

GitHub Actions runtime for building and deploying WordPress components and website releases with WP Git Deploy.

- `gate` asks the site whether the run should build and deploy.
- `package` builds and validates a component or website release.
- `deploy` submits an authenticated deployment and follows its result.
- `edge-check` checks upstream body rejection on the deployment endpoint.

Pin each action to a reviewed commit. For example, a website workflow can start with:

```yaml
permissions:
  contents: read
  id-token: write

jobs:
  review:
    runs-on: [self-hosted, git-deploy-site]
    steps:
      - uses: rzarandona/wp-git-deploy-actions/gate@COMMIT_SHA
        id: gate
        with:
          mode: website
          site-url: ${{ vars.GIT_DEPLOY_SITE }}
          credential: ${{ vars.GIT_DEPLOY_CREDENTIAL }}
          dispatch-request-id: ${{ inputs.request_id }}
          dispatch-commit: ${{ inputs.commit_sha }}
```

Replace `COMMIT_SHA` with the reviewed action commit. Configure the site URL and its OIDC credential ID for the intended site. Website dispatches use the request ID and exact commit supplied by that site. The runner must be able to reach it.

Actions use Node.js 24. Packaging also requires Git and 64-bit PHP with the `zip`, `intl`, `mbstring`, and `zlib` extensions. Component mode uses a dedicated site credential supplied through a GitHub secret; website mode uses GitHub OIDC.

Refer to each action's `action.yml` for its inputs and outputs. This repository contains the runtime only.
