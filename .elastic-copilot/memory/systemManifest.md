# System Manifest

## Project Overview
- Name: Paymerch-Mobile-Prototype
- Description: CRCT-enabled project: Paymerch-Mobile-Prototype
- Created: 2026-09-14T20:59:51.710Z

## Current Status
- Current Phase: Set-up/Maintenance
- Last Updated: 2026-09-14T21:00:03.735Z

## Project Structure

- 37 ts files
- 65 tsx files
- 3 js files


## Dependencies

## Project Directory Structure

- 📂 artifacts/
  - 📂 api-server/
    - 📂 src/
      - 📂 lib/
        ...
      - 📂 middlewares/
        ...
      - 📂 routes/
        ...
      - 📄 app.ts
      - 📄 index.ts
    - 📄 build.mjs
  - 📂 mockup-sandbox/
    - 📂 src/
      - 📂 components/
        ...
      - 📂 hooks/
        ...
      - 📂 lib/
        ...
      - 📄 App.tsx
      - 📄 index.css
      - 📄 main.tsx
    - 📄 index.html
    - 📄 mockupPreviewPlugin.ts
    - 📄 vite.config.ts
  - 📂 paymerch-mobile/
    - 📂 app/
      - 📂 (tabs)/
        ...
      - 📄 _layout.tsx
      - 📄 +not-found.tsx
      - 📄 index.tsx
    - 📂 assets/
      - 📂 images/
        ...
    - 📂 components/
      - 📄 ErrorBoundary.tsx
      - 📄 ErrorFallback.tsx
      - 📄 KeyboardAwareScrollViewCompat.tsx
    - 📂 constants/
      - 📄 colors.ts
    - 📂 hooks/
      - 📄 useColors.ts
    - 📂 scripts/
      - 📄 build.js
    - 📂 server/
      - 📂 templates/
        ...
      - 📄 serve.js
    - 📂 state/
      - 📄 paymerch-context.tsx
    - 📄 expo-env.d.ts
    - 📄 metro.config.js
- 📂 attached_assets/
  - 📄 icon_paymerch_1789169976692.png
- 📂 lib/
  - 📂 api-client-react/
    - 📂 src/
      - 📂 generated/
        ...
      - 📄 custom-fetch.ts
      - 📄 index.ts
    - 📄 tsconfig.tsbuildinfo
  - 📂 api-spec/
    - 📄 openapi.yaml
    - 📄 orval.config.ts
  - 📂 api-zod/
    - 📂 src/
      - 📂 generated/
        ...
      - 📄 index.ts
    - 📄 tsconfig.tsbuildinfo
  - 📂 db/
    - 📂 src/
      - 📂 schema/
        ...
      - 📄 index.ts
    - 📄 drizzle.config.ts
    - 📄 tsconfig.tsbuildinfo
- 📂 scripts/
  - 📂 src/
    - 📄 hello.ts
  - 📄 post-merge.sh
  - 📄 tsconfig.tsbuildinfo
- 📄 _redirects
- 📄 netlify.toml
- 📄 pnpm-lock.yaml
- 📄 pnpm-workspace.yaml


## TS Dependencies

### \scripts\src\hello.ts
No dependencies found

### \lib\db\src\schema\index.ts
Dependencies:
- drizzle-orm/pg-core
- drizzle-zod
- zod/v4

### \lib\db\src\index.ts
Dependencies:
- drizzle-orm/node-postgres
- pg
- ./schema

### \artifacts\paymerch-mobile\.expo\types\router.d.ts
Dependencies:
- expo-router

### \artifacts\mockup-sandbox\vite.config.ts
Dependencies:
- vite
- @vitejs/plugin-react
- @tailwindcss/vite
- path
- @replit/vite-plugin-runtime-error-modal
- ./mockupPreviewPlugin

## TSX Dependencies

### \artifacts\paymerch-mobile\state\paymerch-context.tsx
Dependencies:
- @react-native-async-storage/async-storage
- react

### \artifacts\mockup-sandbox\src\main.tsx
Dependencies:
- react-dom/client
- ./App
- ./index.css

### \artifacts\mockup-sandbox\src\hooks\use-mobile.tsx
Dependencies:
- react

### \artifacts\mockup-sandbox\src\components\ui\tooltip.tsx
Dependencies:
- react
- @radix-ui/react-tooltip
- @/lib/utils

### \artifacts\mockup-sandbox\src\components\ui\toggle.tsx
Dependencies:
- react
- @radix-ui/react-toggle
- class-variance-authority
- @/lib/utils

## JS Dependencies

### \artifacts\paymerch-mobile\server\serve.js
Dependencies:
- http
- fs
- path

### \artifacts\paymerch-mobile\scripts\build.js
Dependencies:
- fs
- path
- child_process
- stream
- stream/promises

### \artifacts\paymerch-mobile\metro.config.js
Dependencies:
- expo/metro-config



## Key Components
- TBD

## Integration Points
- TBD

## Technical Considerations
- TBD

## Implementation Notes
- TBD
