# Docs historical rule inventory

## At a glance

The initial Oxc migration omitted historical docs checks because plugin selection did not enable their rules.
The shared policy restores supported ESLint recommendations and Biome mappings labeled same for introduced docs code.
Existing docs debt remains unchanged, with unsupported and approximate mappings documented individually below.

## Scope and reproduction

Historical docs/yarn.lock selects ESLint 9.38.0, typescript-eslint 8.46.2, and Biome 2.2.3.
The audit installed those exact tools separately with compatible TypeScript 5.9.2.
Current checks use Oxlint 1.86.0 and Oxfmt 0.71.0.
`oxlint --print-config -c .oxlintrc.policy.json` validates the restored introduced-code configuration.
`oxlint --print-config -c docs/.oxlintrc.json` describes the separate existing full-tree docs lint command.
`oxlint --rules --format=json` identifies registered rules and type-aware requirements.

Docs overrides follow general overrides in the shared introduced-code policy.
Unicorn and Next.js plugins are enabled only within those docs overrides.
The Next.js page-specific custom-font restriction is disabled because these docs use Rspress.
Common entries restore inherited root exceptions, including unused variables, useless catches, and TypeScript comment checks.
JavaScript enables no-undef; TypeScript leaves that compiler-overlap check off.
Biome independently required TypeScript no-redeclare, so the docs override restores it.
Warnings also block when introduced on changed lines.
Standalone docs lint retains its existing warning debt and configuration.

Same-source metadata identifies intended upstream counterparts; it does not prove identical implementations.
The accessibility failure/correction fixture establishes actual execution of a restored docs rule.
Inspired and manual mappings below remain explicit exceptions unless another supported same mapping covers the rule.
Type-aware dot-notation and prefer-optional-chain remain exceptions because docs uses the ordinary lint pass.

## Historical ESLint and TypeScript recommendations

All supported recommendations are restored with historical severities in the docs policy overrides.
The table records mappings absent from the initial docs Oxc configuration.
Parser equivalents were verified with ES-module fixtures; sloppy-script equivalence is not claimed.

| Scope | Historical rule | Oxc mapping | Introduced-code coverage |
| --- | --- | --- | --- |
| JavaScript | `no-case-declarations` | `no-case-declarations` | restored |
| JavaScript | `no-dupe-args` | `no-dupe-args` | parser equivalent (ES module fixture) |
| JavaScript | `no-empty` | `no-empty` | restored |
| JavaScript | `no-fallthrough` | `no-fallthrough` | restored |
| JavaScript | `no-octal` | `no-octal` | parser equivalent (ES module fixture) |
| JavaScript | `no-prototype-builtins` | `no-prototype-builtins` | restored |
| JavaScript | `no-redeclare` | `no-redeclare` | restored |
| JavaScript | `no-regex-spaces` | `no-regex-spaces` | restored |
| JavaScript | `no-undef` | `no-undef` | restored |
| JavaScript | `no-unexpected-multiline` | `no-unexpected-multiline` | restored |
| JavaScript | `@typescript-eslint/ban-ts-comment` | `typescript/ban-ts-comment` | restored |
| JavaScript | `@typescript-eslint/no-array-constructor` | `no-array-constructor` | restored |
| JavaScript | `@typescript-eslint/no-empty-object-type` | `typescript/no-empty-object-type` | restored |
| JavaScript | `@typescript-eslint/no-explicit-any` | `typescript/no-explicit-any` | restored |
| JavaScript | `@typescript-eslint/no-namespace` | `typescript/no-namespace` | restored |
| JavaScript | `@typescript-eslint/no-require-imports` | `typescript/no-require-imports` | restored |
| JavaScript | `@typescript-eslint/no-unnecessary-type-constraint` | `typescript/no-unnecessary-type-constraint` | restored |
| JavaScript | `@typescript-eslint/no-unsafe-function-type` | `typescript/no-unsafe-function-type` | restored |
| TypeScript | `no-case-declarations` | `no-case-declarations` | restored |
| TypeScript | `no-empty` | `no-empty` | restored |
| TypeScript | `no-fallthrough` | `no-fallthrough` | restored |
| TypeScript | `no-octal` | `no-octal` | parser equivalent (ES module fixture) |
| TypeScript | `no-prototype-builtins` | `no-prototype-builtins` | restored |
| TypeScript | `no-regex-spaces` | `no-regex-spaces` | restored |
| TypeScript | `no-unexpected-multiline` | `no-unexpected-multiline` | restored |
| TypeScript | `no-var` | `no-var` | restored |
| TypeScript | `prefer-const` | `prefer-const` | restored |
| TypeScript | `prefer-rest-params` | `prefer-rest-params` | restored |
| TypeScript | `prefer-spread` | `prefer-spread` | restored |
| TypeScript | `@typescript-eslint/ban-ts-comment` | `typescript/ban-ts-comment` | restored |
| TypeScript | `@typescript-eslint/no-array-constructor` | `no-array-constructor` | restored |
| TypeScript | `@typescript-eslint/no-empty-object-type` | `typescript/no-empty-object-type` | restored |
| TypeScript | `@typescript-eslint/no-explicit-any` | `typescript/no-explicit-any` | restored |
| TypeScript | `@typescript-eslint/no-namespace` | `typescript/no-namespace` | restored |
| TypeScript | `@typescript-eslint/no-require-imports` | `typescript/no-require-imports` | restored |
| TypeScript | `@typescript-eslint/no-unnecessary-type-constraint` | `typescript/no-unnecessary-type-constraint` | restored |
| TypeScript | `@typescript-eslint/no-unsafe-function-type` | `typescript/no-unsafe-function-type` | restored |

## All 207 stable Biome recommendations

Nursery recommendations are excluded, matching historical stable Biome behavior.
Each rule links to its versioned primary implementation and mapping metadata.
Full-tree means the existing docs lint command already maps that rule.
Introduced means the shared policy explicitly configures its supported same-source counterpart.

| Historical rule | Language | Available Oxc mapping | Existing docs lint | Introduced policy | Source relation |
| --- | --- | --- | --- | --- | --- |
| [a11y/noAccessKey](https://raw.githubusercontent.com/biomejs/biome/%40biomejs/biome%402.2.3/crates/biome_js_analyze/src/lint/a11y/no_access_key.rs) | js | `jsx-a11y/no-access-key` | absent | configured | same |
| [a11y/noAriaHiddenOnFocusable](https://raw.githubusercontent.com/biomejs/biome/%40biomejs/biome%402.2.3/crates/biome_js_analyze/src/lint/a11y/no_aria_hidden_on_focusable.rs) | js | `jsx-a11y/no-aria-hidden-on-focusable` | absent | configured | same |
| [a11y/noAriaUnsupportedElements](https://raw.githubusercontent.com/biomejs/biome/%40biomejs/biome%402.2.3/crates/biome_js_analyze/src/lint/a11y/no_aria_unsupported_elements.rs) | js | `jsx-a11y/aria-unsupported-elements` | absent | configured | same |
| [a11y/noAutofocus](https://raw.githubusercontent.com/biomejs/biome/%40biomejs/biome%402.2.3/crates/biome_js_analyze/src/lint/a11y/no_autofocus.rs) | js | `jsx-a11y/no-autofocus` | absent | configured | same |
| [a11y/noDistractingElements](https://raw.githubusercontent.com/biomejs/biome/%40biomejs/biome%402.2.3/crates/biome_js_analyze/src/lint/a11y/no_distracting_elements.rs) | js | `jsx-a11y/no-distracting-elements` | absent | configured | same |
| [a11y/noHeaderScope](https://raw.githubusercontent.com/biomejs/biome/%40biomejs/biome%402.2.3/crates/biome_js_analyze/src/lint/a11y/no_header_scope.rs) | js | `jsx-a11y/scope` | absent | configured | same |
| [a11y/noInteractiveElementToNoninteractiveRole](https://raw.githubusercontent.com/biomejs/biome/%40biomejs/biome%402.2.3/crates/biome_js_analyze/src/lint/a11y/no_interactive_element_to_noninteractive_role.rs) | js | `jsx-a11y/no-interactive-element-to-noninteractive-role` | absent | configured | same |
| [a11y/noLabelWithoutControl](https://raw.githubusercontent.com/biomejs/biome/%40biomejs/biome%402.2.3/crates/biome_js_analyze/src/lint/a11y/no_label_without_control.rs) | js | `jsx-a11y/label-has-associated-control` | absent | configured | same |
| [a11y/noNoninteractiveElementToInteractiveRole](https://raw.githubusercontent.com/biomejs/biome/%40biomejs/biome%402.2.3/crates/biome_js_analyze/src/lint/a11y/no_noninteractive_element_to_interactive_role.rs) | js | `jsx-a11y/no-noninteractive-element-to-interactive-role` | absent | configured | same |
| [a11y/noNoninteractiveTabindex](https://raw.githubusercontent.com/biomejs/biome/%40biomejs/biome%402.2.3/crates/biome_js_analyze/src/lint/a11y/no_noninteractive_tabindex.rs) | js | `jsx-a11y/no-noninteractive-tabindex` | absent | configured | same |
| [a11y/noPositiveTabindex](https://raw.githubusercontent.com/biomejs/biome/%40biomejs/biome%402.2.3/crates/biome_js_analyze/src/lint/a11y/no_positive_tabindex.rs) | js | `jsx-a11y/tabindex-no-positive` | absent | configured | same |
| [a11y/noRedundantAlt](https://raw.githubusercontent.com/biomejs/biome/%40biomejs/biome%402.2.3/crates/biome_js_analyze/src/lint/a11y/no_redundant_alt.rs) | js | `jsx-a11y/img-redundant-alt` | absent | configured | same |
| [a11y/noRedundantRoles](https://raw.githubusercontent.com/biomejs/biome/%40biomejs/biome%402.2.3/crates/biome_js_analyze/src/lint/a11y/no_redundant_roles.rs) | js | `jsx-a11y/no-redundant-roles` | absent | configured | same |
| [a11y/noStaticElementInteractions](https://raw.githubusercontent.com/biomejs/biome/%40biomejs/biome%402.2.3/crates/biome_js_analyze/src/lint/a11y/no_static_element_interactions.rs) | js | `jsx-a11y/no-static-element-interactions` | absent | configured | same |
| [a11y/noSvgWithoutTitle](https://raw.githubusercontent.com/biomejs/biome/%40biomejs/biome%402.2.3/crates/biome_js_analyze/src/lint/a11y/no_svg_without_title.rs) | js | none | absent | coverage exception | none |
| [a11y/useAltText](https://raw.githubusercontent.com/biomejs/biome/%40biomejs/biome%402.2.3/crates/biome_js_analyze/src/lint/a11y/use_alt_text.rs) | js | `jsx-a11y/alt-text` | absent | configured | same |
| [a11y/useAnchorContent](https://raw.githubusercontent.com/biomejs/biome/%40biomejs/biome%402.2.3/crates/biome_js_analyze/src/lint/a11y/use_anchor_content.rs) | js | `jsx-a11y/anchor-has-content` | absent | configured | same |
| [a11y/useAriaActivedescendantWithTabindex](https://raw.githubusercontent.com/biomejs/biome/%40biomejs/biome%402.2.3/crates/biome_js_analyze/src/lint/a11y/use_aria_activedescendant_with_tabindex.rs) | js | `jsx-a11y/aria-activedescendant-has-tabindex` | absent | configured | same |
| [a11y/useAriaPropsForRole](https://raw.githubusercontent.com/biomejs/biome/%40biomejs/biome%402.2.3/crates/biome_js_analyze/src/lint/a11y/use_aria_props_for_role.rs) | js | `jsx-a11y/role-has-required-aria-props` | absent | configured | same |
| [a11y/useAriaPropsSupportedByRole](https://raw.githubusercontent.com/biomejs/biome/%40biomejs/biome%402.2.3/crates/biome_js_analyze/src/lint/a11y/use_aria_props_supported_by_role.rs) | js | `jsx-a11y/role-supports-aria-props` | absent | configured | same |
| [a11y/useButtonType](https://raw.githubusercontent.com/biomejs/biome/%40biomejs/biome%402.2.3/crates/biome_js_analyze/src/lint/a11y/use_button_type.rs) | js | `react/button-has-type` | absent | configured | same |
| [a11y/useFocusableInteractive](https://raw.githubusercontent.com/biomejs/biome/%40biomejs/biome%402.2.3/crates/biome_js_analyze/src/lint/a11y/use_focusable_interactive.rs) | js | `jsx-a11y/interactive-supports-focus` | absent | configured | same |
| [a11y/useGenericFontNames](https://raw.githubusercontent.com/biomejs/biome/%40biomejs/biome%402.2.3/crates/biome_css_analyze/src/lint/a11y/use_generic_font_names.rs) | css | none | absent | coverage exception | none |
| [a11y/useHeadingContent](https://raw.githubusercontent.com/biomejs/biome/%40biomejs/biome%402.2.3/crates/biome_js_analyze/src/lint/a11y/use_heading_content.rs) | js | `jsx-a11y/heading-has-content` | absent | configured | same |
| [a11y/useHtmlLang](https://raw.githubusercontent.com/biomejs/biome/%40biomejs/biome%402.2.3/crates/biome_js_analyze/src/lint/a11y/use_html_lang.rs) | js | `jsx-a11y/html-has-lang` | absent | configured | same |
| [a11y/useIframeTitle](https://raw.githubusercontent.com/biomejs/biome/%40biomejs/biome%402.2.3/crates/biome_js_analyze/src/lint/a11y/use_iframe_title.rs) | js | `jsx-a11y/iframe-has-title` | absent | configured | same |
| [a11y/useKeyWithClickEvents](https://raw.githubusercontent.com/biomejs/biome/%40biomejs/biome%402.2.3/crates/biome_js_analyze/src/lint/a11y/use_key_with_click_events.rs) | js | `jsx-a11y/click-events-have-key-events` | absent | configured | same |
| [a11y/useKeyWithMouseEvents](https://raw.githubusercontent.com/biomejs/biome/%40biomejs/biome%402.2.3/crates/biome_js_analyze/src/lint/a11y/use_key_with_mouse_events.rs) | js | `jsx-a11y/mouse-events-have-key-events` | absent | configured | same |
| [a11y/useMediaCaption](https://raw.githubusercontent.com/biomejs/biome/%40biomejs/biome%402.2.3/crates/biome_js_analyze/src/lint/a11y/use_media_caption.rs) | js | `jsx-a11y/media-has-caption` | absent | configured | same |
| [a11y/useSemanticElements](https://raw.githubusercontent.com/biomejs/biome/%40biomejs/biome%402.2.3/crates/biome_js_analyze/src/lint/a11y/use_semantic_elements.rs) | js | `jsx-a11y/prefer-tag-over-role` | absent | configured | same |
| [a11y/useValidAnchor](https://raw.githubusercontent.com/biomejs/biome/%40biomejs/biome%402.2.3/crates/biome_js_analyze/src/lint/a11y/use_valid_anchor.rs) | js | `jsx-a11y/anchor-is-valid` | absent | configured | same |
| [a11y/useValidAriaProps](https://raw.githubusercontent.com/biomejs/biome/%40biomejs/biome%402.2.3/crates/biome_js_analyze/src/lint/a11y/use_valid_aria_props.rs) | js | `jsx-a11y/aria-props` | absent | configured | same |
| [a11y/useValidAriaRole](https://raw.githubusercontent.com/biomejs/biome/%40biomejs/biome%402.2.3/crates/biome_js_analyze/src/lint/a11y/use_valid_aria_role.rs) | js | `jsx-a11y/aria-role` | absent | configured | same |
| [a11y/useValidAriaValues](https://raw.githubusercontent.com/biomejs/biome/%40biomejs/biome%402.2.3/crates/biome_js_analyze/src/lint/a11y/use_valid_aria_values.rs) | js | `jsx-a11y/aria-proptypes` | absent | configured | same |
| [a11y/useValidAutocomplete](https://raw.githubusercontent.com/biomejs/biome/%40biomejs/biome%402.2.3/crates/biome_js_analyze/src/lint/a11y/use_valid_autocomplete.rs) | js | `jsx-a11y/autocomplete-valid` | absent | configured | same |
| [a11y/useValidLang](https://raw.githubusercontent.com/biomejs/biome/%40biomejs/biome%402.2.3/crates/biome_js_analyze/src/lint/a11y/use_valid_lang.rs) | js | `jsx-a11y/lang` | absent | configured | same |
| [complexity/noAdjacentSpacesInRegex](https://raw.githubusercontent.com/biomejs/biome/%40biomejs/biome%402.2.3/crates/biome_js_analyze/src/lint/complexity/no_adjacent_spaces_in_regex.rs) | js | `no-regex-spaces` | absent | configured | same |
| [complexity/noArguments](https://raw.githubusercontent.com/biomejs/biome/%40biomejs/biome%402.2.3/crates/biome_js_analyze/src/lint/complexity/no_arguments.rs) | js | `prefer-rest-params` | absent | configured | same |
| [complexity/noBannedTypes](https://raw.githubusercontent.com/biomejs/biome/%40biomejs/biome%402.2.3/crates/biome_js_analyze/src/lint/complexity/no_banned_types.rs) | js | `typescript/ban-types` | absent | configured | same |
| [complexity/noCommaOperator](https://raw.githubusercontent.com/biomejs/biome/%40biomejs/biome%402.2.3/crates/biome_js_analyze/src/lint/complexity/no_comma_operator.rs) | js | `no-sequences` | absent | configured | same |
| [complexity/noEmptyTypeParameters](https://raw.githubusercontent.com/biomejs/biome/%40biomejs/biome%402.2.3/crates/biome_js_analyze/src/lint/complexity/no_empty_type_parameters.rs) | js | none | absent | parser fixture | none |
| [complexity/noExtraBooleanCast](https://raw.githubusercontent.com/biomejs/biome/%40biomejs/biome%402.2.3/crates/biome_js_analyze/src/lint/complexity/no_extra_boolean_cast.rs) | js | `no-extra-boolean-cast` | mapped | configured | same |
| [complexity/noFlatMapIdentity](https://raw.githubusercontent.com/biomejs/biome/%40biomejs/biome%402.2.3/crates/biome_js_analyze/src/lint/complexity/no_flat_map_identity.rs) | js | none | absent | coverage exception | none |
| [complexity/noImportantStyles](https://raw.githubusercontent.com/biomejs/biome/%40biomejs/biome%402.2.3/crates/biome_css_analyze/src/lint/complexity/no_important_styles.rs) | css | none | absent | coverage exception | none |
| [complexity/noStaticOnlyClass](https://raw.githubusercontent.com/biomejs/biome/%40biomejs/biome%402.2.3/crates/biome_js_analyze/src/lint/complexity/no_static_only_class.rs) | js | `typescript/no-extraneous-class`, `unicorn/no-static-only-class` | absent | configured | same, same |
| [complexity/noThisInStatic](https://raw.githubusercontent.com/biomejs/biome/%40biomejs/biome%402.2.3/crates/biome_js_analyze/src/lint/complexity/no_this_in_static.rs) | js | none | absent | coverage exception | none |
| [complexity/noUselessCatch](https://raw.githubusercontent.com/biomejs/biome/%40biomejs/biome%402.2.3/crates/biome_js_analyze/src/lint/complexity/no_useless_catch.rs) | js | `no-useless-catch` | mapped | configured | same |
| [complexity/noUselessConstructor](https://raw.githubusercontent.com/biomejs/biome/%40biomejs/biome%402.2.3/crates/biome_js_analyze/src/lint/complexity/no_useless_constructor.rs) | js | `no-useless-constructor` | absent | configured | same |
| [complexity/noUselessContinue](https://raw.githubusercontent.com/biomejs/biome/%40biomejs/biome%402.2.3/crates/biome_js_analyze/src/lint/complexity/no_useless_continue.rs) | js | none | absent | coverage exception | none |
| [complexity/noUselessEmptyExport](https://raw.githubusercontent.com/biomejs/biome/%40biomejs/biome%402.2.3/crates/biome_js_analyze/src/lint/complexity/no_useless_empty_export.rs) | js | `typescript/no-useless-empty-export` | mapped | configured | same |
| [complexity/noUselessEscapeInRegex](https://raw.githubusercontent.com/biomejs/biome/%40biomejs/biome%402.2.3/crates/biome_js_analyze/src/lint/complexity/no_useless_escape_in_regex.rs) | js | `no-useless-escape` | mapped | configured | same |
| [complexity/noUselessFragments](https://raw.githubusercontent.com/biomejs/biome/%40biomejs/biome%402.2.3/crates/biome_js_analyze/src/lint/complexity/no_useless_fragments.rs) | js | `react/jsx-no-useless-fragment` | absent | configured | same |
| [complexity/noUselessLabel](https://raw.githubusercontent.com/biomejs/biome/%40biomejs/biome%402.2.3/crates/biome_js_analyze/src/lint/complexity/no_useless_label.rs) | js | `no-extra-label` | absent | configured | same |
| [complexity/noUselessLoneBlockStatements](https://raw.githubusercontent.com/biomejs/biome/%40biomejs/biome%402.2.3/crates/biome_js_analyze/src/lint/complexity/no_useless_lone_block_statements.rs) | js | `no-lone-blocks` | absent | configured | same |
| [complexity/noUselessRename](https://raw.githubusercontent.com/biomejs/biome/%40biomejs/biome%402.2.3/crates/biome_js_analyze/src/lint/complexity/no_useless_rename.rs) | js | `no-useless-rename` | mapped | configured | same |
| [complexity/noUselessStringRaw](https://raw.githubusercontent.com/biomejs/biome/%40biomejs/biome%402.2.3/crates/biome_js_analyze/src/lint/complexity/no_useless_string_raw.rs) | js | none | absent | coverage exception | none |
| [complexity/noUselessSwitchCase](https://raw.githubusercontent.com/biomejs/biome/%40biomejs/biome%402.2.3/crates/biome_js_analyze/src/lint/complexity/no_useless_switch_case.rs) | js | `unicorn/no-useless-switch-case` | absent | configured | same |
| [complexity/noUselessTernary](https://raw.githubusercontent.com/biomejs/biome/%40biomejs/biome%402.2.3/crates/biome_js_analyze/src/lint/complexity/no_useless_ternary.rs) | js | `no-unneeded-ternary` | absent | configured | same |
| [complexity/noUselessThisAlias](https://raw.githubusercontent.com/biomejs/biome/%40biomejs/biome%402.2.3/crates/biome_js_analyze/src/lint/complexity/no_useless_this_alias.rs) | js | `typescript/no-this-alias` | mapped | coverage exception | inspired |
| [complexity/noUselessTypeConstraint](https://raw.githubusercontent.com/biomejs/biome/%40biomejs/biome%402.2.3/crates/biome_js_analyze/src/lint/complexity/no_useless_type_constraint.rs) | js | `typescript/no-unnecessary-type-constraint` | absent | configured | same |
| [complexity/noUselessUndefinedInitialization](https://raw.githubusercontent.com/biomejs/biome/%40biomejs/biome%402.2.3/crates/biome_js_analyze/src/lint/complexity/no_useless_undefined_initialization.rs) | js | `unicorn/no-useless-undefined` | absent | coverage exception | broader check |
| [complexity/useArrowFunction](https://raw.githubusercontent.com/biomejs/biome/%40biomejs/biome%402.2.3/crates/biome_js_analyze/src/lint/complexity/use_arrow_function.rs) | js | `prefer-arrow-callback` | absent | coverage exception | inspired |
| [complexity/useDateNow](https://raw.githubusercontent.com/biomejs/biome/%40biomejs/biome%402.2.3/crates/biome_js_analyze/src/lint/complexity/use_date_now.rs) | js | `unicorn/prefer-date-now` | absent | configured | same |
| [complexity/useFlatMap](https://raw.githubusercontent.com/biomejs/biome/%40biomejs/biome%402.2.3/crates/biome_js_analyze/src/lint/complexity/use_flat_map.rs) | js | `unicorn/prefer-array-flat-map` | absent | configured | same |
| [complexity/useIndexOf](https://raw.githubusercontent.com/biomejs/biome/%40biomejs/biome%402.2.3/crates/biome_js_analyze/src/lint/complexity/use_index_of.rs) | js | `unicorn/prefer-array-index-of` | absent | configured | same |
| [complexity/useLiteralKeys](https://raw.githubusercontent.com/biomejs/biome/%40biomejs/biome%402.2.3/crates/biome_js_analyze/src/lint/complexity/use_literal_keys.rs) | js | `no-useless-computed-key`, `typescript/dot-notation` | absent | `no-useless-computed-key` configured; `typescript/dot-notation` coverage exception | same, same |
| [complexity/useNumericLiterals](https://raw.githubusercontent.com/biomejs/biome/%40biomejs/biome%402.2.3/crates/biome_js_analyze/src/lint/complexity/use_numeric_literals.rs) | js | `prefer-numeric-literals` | absent | configured | same |
| [complexity/useOptionalChain](https://raw.githubusercontent.com/biomejs/biome/%40biomejs/biome%402.2.3/crates/biome_js_analyze/src/lint/complexity/use_optional_chain.rs) | js | `typescript/prefer-optional-chain` | absent | coverage exception | same |
| [complexity/useRegexLiterals](https://raw.githubusercontent.com/biomejs/biome/%40biomejs/biome%402.2.3/crates/biome_js_analyze/src/lint/complexity/use_regex_literals.rs) | js | `prefer-regex-literals` | absent | configured | same |
| [complexity/useSimpleNumberKeys](https://raw.githubusercontent.com/biomejs/biome/%40biomejs/biome%402.2.3/crates/biome_js_analyze/src/lint/complexity/use_simple_number_keys.rs) | js | none | absent | coverage exception | none |
| [correctness/noChildrenProp](https://raw.githubusercontent.com/biomejs/biome/%40biomejs/biome%402.2.3/crates/biome_js_analyze/src/lint/correctness/no_children_prop.rs) | js | `react/no-children-prop` | absent | configured | same |
| [correctness/noConstAssign](https://raw.githubusercontent.com/biomejs/biome/%40biomejs/biome%402.2.3/crates/biome_js_analyze/src/lint/correctness/no_const_assign.rs) | js | `no-const-assign` | mapped | configured | same |
| [correctness/noConstantCondition](https://raw.githubusercontent.com/biomejs/biome/%40biomejs/biome%402.2.3/crates/biome_js_analyze/src/lint/correctness/no_constant_condition.rs) | js | `no-constant-condition` | mapped | configured | same |
| [correctness/noConstantMathMinMaxClamp](https://raw.githubusercontent.com/biomejs/biome/%40biomejs/biome%402.2.3/crates/biome_js_analyze/src/lint/correctness/no_constant_math_min_max_clamp.rs) | js | none | absent | coverage exception | none |
| [correctness/noConstructorReturn](https://raw.githubusercontent.com/biomejs/biome/%40biomejs/biome%402.2.3/crates/biome_js_analyze/src/lint/correctness/no_constructor_return.rs) | js | `no-constructor-return` | absent | configured | same |
| [correctness/noEmptyCharacterClassInRegex](https://raw.githubusercontent.com/biomejs/biome/%40biomejs/biome%402.2.3/crates/biome_js_analyze/src/lint/correctness/no_empty_character_class_in_regex.rs) | js | `no-empty-character-class` | mapped | configured | same |
| [correctness/noEmptyPattern](https://raw.githubusercontent.com/biomejs/biome/%40biomejs/biome%402.2.3/crates/biome_js_analyze/src/lint/correctness/no_empty_pattern.rs) | js | `no-empty-pattern` | mapped | configured | same |
| [correctness/noGlobalObjectCalls](https://raw.githubusercontent.com/biomejs/biome/%40biomejs/biome%402.2.3/crates/biome_js_analyze/src/lint/correctness/no_global_object_calls.rs) | js | `no-obj-calls` | mapped | configured | same |
| [correctness/noInnerDeclarations](https://raw.githubusercontent.com/biomejs/biome/%40biomejs/biome%402.2.3/crates/biome_js_analyze/src/lint/correctness/no_inner_declarations.rs) | js | `no-inner-declarations` | absent | configured | same |
| [correctness/noInvalidBuiltinInstantiation](https://raw.githubusercontent.com/biomejs/biome/%40biomejs/biome%402.2.3/crates/biome_js_analyze/src/lint/correctness/no_invalid_builtin_instantiation.rs) | js | `unicorn/new-for-builtins`, `no-new-native-nonconstructor` | mapped | configured | same, same |
| [correctness/noInvalidConstructorSuper](https://raw.githubusercontent.com/biomejs/biome/%40biomejs/biome%402.2.3/crates/biome_js_analyze/src/lint/correctness/no_invalid_constructor_super.rs) | js | `constructor-super` | mapped | configured | same |
| [correctness/noInvalidDirectionInLinearGradient](https://raw.githubusercontent.com/biomejs/biome/%40biomejs/biome%402.2.3/crates/biome_css_analyze/src/lint/correctness/no_invalid_direction_in_linear_gradient.rs) | css | none | absent | coverage exception | none |
| [correctness/noInvalidGridAreas](https://raw.githubusercontent.com/biomejs/biome/%40biomejs/biome%402.2.3/crates/biome_css_analyze/src/lint/correctness/no_invalid_grid_areas.rs) | css | none | absent | coverage exception | none |
| [correctness/noInvalidPositionAtImportRule](https://raw.githubusercontent.com/biomejs/biome/%40biomejs/biome%402.2.3/crates/biome_css_analyze/src/lint/correctness/no_invalid_position_at_import_rule.rs) | css | none | absent | coverage exception | none |
| [correctness/noInvalidUseBeforeDeclaration](https://raw.githubusercontent.com/biomejs/biome/%40biomejs/biome%402.2.3/crates/biome_js_analyze/src/lint/correctness/no_invalid_use_before_declaration.rs) | js | `no-use-before-define` | absent | configured | same |
| [correctness/noMissingVarFunction](https://raw.githubusercontent.com/biomejs/biome/%40biomejs/biome%402.2.3/crates/biome_css_analyze/src/lint/correctness/no_missing_var_function.rs) | css | none | absent | coverage exception | none |
| [correctness/noNonoctalDecimalEscape](https://raw.githubusercontent.com/biomejs/biome/%40biomejs/biome%402.2.3/crates/biome_js_analyze/src/lint/correctness/no_nonoctal_decimal_escape.rs) | js | `no-nonoctal-decimal-escape` | mapped | configured | same |
| [correctness/noPrecisionLoss](https://raw.githubusercontent.com/biomejs/biome/%40biomejs/biome%402.2.3/crates/biome_js_analyze/src/lint/correctness/no_precision_loss.rs) | js | `no-loss-of-precision`, `no-loss-of-precision` | mapped | configured | same, same |
| [correctness/noSelfAssign](https://raw.githubusercontent.com/biomejs/biome/%40biomejs/biome%402.2.3/crates/biome_js_analyze/src/lint/correctness/no_self_assign.rs) | js | `no-self-assign` | mapped | configured | same |
| [correctness/noSetterReturn](https://raw.githubusercontent.com/biomejs/biome/%40biomejs/biome%402.2.3/crates/biome_js_analyze/src/lint/correctness/no_setter_return.rs) | js | `no-setter-return` | mapped | configured | same |
| [correctness/noStringCaseMismatch](https://raw.githubusercontent.com/biomejs/biome/%40biomejs/biome%402.2.3/crates/biome_js_analyze/src/lint/correctness/no_string_case_mismatch.rs) | js | none | absent | coverage exception | none |
| [correctness/noSwitchDeclarations](https://raw.githubusercontent.com/biomejs/biome/%40biomejs/biome%402.2.3/crates/biome_js_analyze/src/lint/correctness/no_switch_declarations.rs) | js | `no-case-declarations` | absent | configured | same |
| [correctness/noUnknownFunction](https://raw.githubusercontent.com/biomejs/biome/%40biomejs/biome%402.2.3/crates/biome_css_analyze/src/lint/correctness/no_unknown_function.rs) | css | none | absent | coverage exception | none |
| [correctness/noUnknownMediaFeatureName](https://raw.githubusercontent.com/biomejs/biome/%40biomejs/biome%402.2.3/crates/biome_css_analyze/src/lint/correctness/no_unknown_media_feature_name.rs) | css | none | absent | coverage exception | none |
| [correctness/noUnknownProperty](https://raw.githubusercontent.com/biomejs/biome/%40biomejs/biome%402.2.3/crates/biome_css_analyze/src/lint/correctness/no_unknown_property.rs) | css | none | absent | coverage exception | none |
| [correctness/noUnknownPseudoClass](https://raw.githubusercontent.com/biomejs/biome/%40biomejs/biome%402.2.3/crates/biome_css_analyze/src/lint/correctness/no_unknown_pseudo_class.rs) | css | none | absent | coverage exception | none |
| [correctness/noUnknownPseudoElement](https://raw.githubusercontent.com/biomejs/biome/%40biomejs/biome%402.2.3/crates/biome_css_analyze/src/lint/correctness/no_unknown_pseudo_element.rs) | css | none | absent | coverage exception | none |
| [correctness/noUnknownTypeSelector](https://raw.githubusercontent.com/biomejs/biome/%40biomejs/biome%402.2.3/crates/biome_css_analyze/src/lint/correctness/no_unknown_type_selector.rs) | css | none | absent | coverage exception | none |
| [correctness/noUnknownUnit](https://raw.githubusercontent.com/biomejs/biome/%40biomejs/biome%402.2.3/crates/biome_css_analyze/src/lint/correctness/no_unknown_unit.rs) | css | none | absent | coverage exception | none |
| [correctness/noUnmatchableAnbSelector](https://raw.githubusercontent.com/biomejs/biome/%40biomejs/biome%402.2.3/crates/biome_css_analyze/src/lint/correctness/no_unmatchable_anb_selector.rs) | css | none | absent | coverage exception | none |
| [correctness/noUnreachable](https://raw.githubusercontent.com/biomejs/biome/%40biomejs/biome%402.2.3/crates/biome_js_analyze/src/lint/correctness/no_unreachable.rs) | js | `no-unreachable` | mapped | configured | same |
| [correctness/noUnreachableSuper](https://raw.githubusercontent.com/biomejs/biome/%40biomejs/biome%402.2.3/crates/biome_js_analyze/src/lint/correctness/no_unreachable_super.rs) | js | `no-this-before-super` | mapped | configured | same |
| [correctness/noUnsafeFinally](https://raw.githubusercontent.com/biomejs/biome/%40biomejs/biome%402.2.3/crates/biome_js_analyze/src/lint/correctness/no_unsafe_finally.rs) | js | `no-unsafe-finally` | mapped | configured | same |
| [correctness/noUnsafeOptionalChaining](https://raw.githubusercontent.com/biomejs/biome/%40biomejs/biome%402.2.3/crates/biome_js_analyze/src/lint/correctness/no_unsafe_optional_chaining.rs) | js | `no-unsafe-optional-chaining` | mapped | configured | same |
| [correctness/noUnusedFunctionParameters](https://raw.githubusercontent.com/biomejs/biome/%40biomejs/biome%402.2.3/crates/biome_js_analyze/src/lint/correctness/no_unused_function_parameters.rs) | js | `no-unused-vars` | mapped | coverage exception | options differ |
| [correctness/noUnusedImports](https://raw.githubusercontent.com/biomejs/biome/%40biomejs/biome%402.2.3/crates/biome_js_analyze/src/lint/correctness/no_unused_imports.rs) | js | `no-unused-vars` | mapped | coverage exception | imports supported; options differ |
| [correctness/noUnusedLabels](https://raw.githubusercontent.com/biomejs/biome/%40biomejs/biome%402.2.3/crates/biome_js_analyze/src/lint/correctness/no_unused_labels.rs) | js | `no-unused-labels` | mapped | configured | same |
| [correctness/noUnusedPrivateClassMembers](https://raw.githubusercontent.com/biomejs/biome/%40biomejs/biome%402.2.3/crates/biome_js_analyze/src/lint/correctness/no_unused_private_class_members.rs) | js | `no-unused-private-class-members` | mapped | configured | same |
| [correctness/noUnusedVariables](https://raw.githubusercontent.com/biomejs/biome/%40biomejs/biome%402.2.3/crates/biome_js_analyze/src/lint/correctness/no_unused_variables.rs) | js | `no-unused-vars`, `no-unused-vars` | mapped | configured | same, same |
| [correctness/noVoidElementsWithChildren](https://raw.githubusercontent.com/biomejs/biome/%40biomejs/biome%402.2.3/crates/biome_js_analyze/src/lint/correctness/no_void_elements_with_children.rs) | js | `react/void-dom-elements-no-children` | absent | configured | same |
| [correctness/noVoidTypeReturn](https://raw.githubusercontent.com/biomejs/biome/%40biomejs/biome%402.2.3/crates/biome_js_analyze/src/lint/correctness/no_void_type_return.rs) | js | none | absent | coverage exception | none |
| [correctness/useGraphqlNamedOperations](https://raw.githubusercontent.com/biomejs/biome/%40biomejs/biome%402.2.3/crates/biome_graphql_analyze/src/lint/correctness/use_graphql_named_operations.rs) | graphql | none | absent | coverage exception | none |
| [correctness/useIsNan](https://raw.githubusercontent.com/biomejs/biome/%40biomejs/biome%402.2.3/crates/biome_js_analyze/src/lint/correctness/use_is_nan.rs) | js | `use-isnan` | mapped | configured | same |
| [correctness/useParseIntRadix](https://raw.githubusercontent.com/biomejs/biome/%40biomejs/biome%402.2.3/crates/biome_js_analyze/src/lint/correctness/use_parse_int_radix.rs) | js | `radix` | absent | configured | same |
| [correctness/useValidForDirection](https://raw.githubusercontent.com/biomejs/biome/%40biomejs/biome%402.2.3/crates/biome_js_analyze/src/lint/correctness/use_valid_for_direction.rs) | js | `for-direction` | mapped | configured | same |
| [correctness/useValidTypeof](https://raw.githubusercontent.com/biomejs/biome/%40biomejs/biome%402.2.3/crates/biome_js_analyze/src/lint/correctness/use_valid_typeof.rs) | js | `valid-typeof` | mapped | configured | same |
| [correctness/useYield](https://raw.githubusercontent.com/biomejs/biome/%40biomejs/biome%402.2.3/crates/biome_js_analyze/src/lint/correctness/use_yield.rs) | js | `require-yield` | mapped | configured | same |
| [performance/noAccumulatingSpread](https://raw.githubusercontent.com/biomejs/biome/%40biomejs/biome%402.2.3/crates/biome_js_analyze/src/lint/performance/no_accumulating_spread.rs) | js | `oxc/no-accumulating-spread` | absent | coverage exception | manual mapping |
| [performance/noDynamicNamespaceImportAccess](https://raw.githubusercontent.com/biomejs/biome/%40biomejs/biome%402.2.3/crates/biome_js_analyze/src/lint/performance/no_dynamic_namespace_import_access.rs) | js | none | absent | coverage exception | none |
| [security/noBlankTarget](https://raw.githubusercontent.com/biomejs/biome/%40biomejs/biome%402.2.3/crates/biome_js_analyze/src/lint/security/no_blank_target.rs) | js | `react/jsx-no-target-blank` | absent | coverage exception | inspired |
| [security/noDangerouslySetInnerHtml](https://raw.githubusercontent.com/biomejs/biome/%40biomejs/biome%402.2.3/crates/biome_js_analyze/src/lint/security/no_dangerously_set_inner_html.rs) | js | `react/no-danger` | absent | configured | same |
| [security/noDangerouslySetInnerHtmlWithChildren](https://raw.githubusercontent.com/biomejs/biome/%40biomejs/biome%402.2.3/crates/biome_js_analyze/src/lint/security/no_dangerously_set_inner_html_with_children.rs) | js | `react/no-danger-with-children` | absent | configured | same |
| [security/noGlobalEval](https://raw.githubusercontent.com/biomejs/biome/%40biomejs/biome%402.2.3/crates/biome_js_analyze/src/lint/security/no_global_eval.rs) | js | `no-eval` | mapped | configured | same |
| [style/noDescendingSpecificity](https://raw.githubusercontent.com/biomejs/biome/%40biomejs/biome%402.2.3/crates/biome_css_analyze/src/lint/style/no_descending_specificity.rs) | css | none | absent | coverage exception | none |
| [style/noNonNullAssertion](https://raw.githubusercontent.com/biomejs/biome/%40biomejs/biome%402.2.3/crates/biome_js_analyze/src/lint/style/no_non_null_assertion.rs) | js | `typescript/no-non-null-assertion` | absent | configured | same |
| [style/useArrayLiterals](https://raw.githubusercontent.com/biomejs/biome/%40biomejs/biome%402.2.3/crates/biome_js_analyze/src/lint/style/use_array_literals.rs) | js | `no-array-constructor`, `no-array-constructor` | absent | configured | same, same |
| [style/useConst](https://raw.githubusercontent.com/biomejs/biome/%40biomejs/biome%402.2.3/crates/biome_js_analyze/src/lint/style/use_const.rs) | js | `prefer-const` | absent | configured | same |
| [style/useDeprecatedReason](https://raw.githubusercontent.com/biomejs/biome/%40biomejs/biome%402.2.3/crates/biome_graphql_analyze/src/lint/style/use_deprecated_reason.rs) | graphql | none | absent | coverage exception | none |
| [style/useExponentiationOperator](https://raw.githubusercontent.com/biomejs/biome/%40biomejs/biome%402.2.3/crates/biome_js_analyze/src/lint/style/use_exponentiation_operator.rs) | js | `prefer-exponentiation-operator` | absent | configured | same |
| [style/useExportType](https://raw.githubusercontent.com/biomejs/biome/%40biomejs/biome%402.2.3/crates/biome_js_analyze/src/lint/style/use_export_type.rs) | js | `typescript/consistent-type-exports` | absent | coverage exception | inspired |
| [style/useImportType](https://raw.githubusercontent.com/biomejs/biome/%40biomejs/biome%402.2.3/crates/biome_js_analyze/src/lint/style/use_import_type.rs) | js | `typescript/consistent-type-imports` | absent | coverage exception | inspired |
| [style/useLiteralEnumMembers](https://raw.githubusercontent.com/biomejs/biome/%40biomejs/biome%402.2.3/crates/biome_js_analyze/src/lint/style/use_literal_enum_members.rs) | js | `typescript/prefer-literal-enum-member` | absent | configured | same |
| [style/useNodejsImportProtocol](https://raw.githubusercontent.com/biomejs/biome/%40biomejs/biome%402.2.3/crates/biome_js_analyze/src/lint/style/use_nodejs_import_protocol.rs) | js | `unicorn/prefer-node-protocol` | absent | configured | same |
| [style/useShorthandFunctionType](https://raw.githubusercontent.com/biomejs/biome/%40biomejs/biome%402.2.3/crates/biome_js_analyze/src/lint/style/use_shorthand_function_type.rs) | js | `typescript/prefer-function-type` | absent | configured | same |
| [style/useTemplate](https://raw.githubusercontent.com/biomejs/biome/%40biomejs/biome%402.2.3/crates/biome_js_analyze/src/lint/style/use_template.rs) | js | `prefer-template` | absent | configured | same |
| [suspicious/noApproximativeNumericConstant](https://raw.githubusercontent.com/biomejs/biome/%40biomejs/biome%402.2.3/crates/biome_js_analyze/src/lint/suspicious/no_approximative_numeric_constant.rs) | js | none | absent | coverage exception | none |
| [suspicious/noArrayIndexKey](https://raw.githubusercontent.com/biomejs/biome/%40biomejs/biome%402.2.3/crates/biome_js_analyze/src/lint/suspicious/no_array_index_key.rs) | js | `react/no-array-index-key` | absent | configured | same |
| [suspicious/noAssignInExpressions](https://raw.githubusercontent.com/biomejs/biome/%40biomejs/biome%402.2.3/crates/biome_js_analyze/src/lint/suspicious/no_assign_in_expressions.rs) | js | `no-cond-assign` | mapped | coverage exception | inspired |
| [suspicious/noAsyncPromiseExecutor](https://raw.githubusercontent.com/biomejs/biome/%40biomejs/biome%402.2.3/crates/biome_js_analyze/src/lint/suspicious/no_async_promise_executor.rs) | js | `no-async-promise-executor` | mapped | configured | same |
| [suspicious/noBiomeFirstException](https://raw.githubusercontent.com/biomejs/biome/%40biomejs/biome%402.2.3/crates/biome_json_analyze/src/lint/suspicious/no_biome_first_exception.rs) | json | none | absent | tool removed | none |
| [suspicious/noCatchAssign](https://raw.githubusercontent.com/biomejs/biome/%40biomejs/biome%402.2.3/crates/biome_js_analyze/src/lint/suspicious/no_catch_assign.rs) | js | `no-ex-assign` | mapped | configured | same |
| [suspicious/noClassAssign](https://raw.githubusercontent.com/biomejs/biome/%40biomejs/biome%402.2.3/crates/biome_js_analyze/src/lint/suspicious/no_class_assign.rs) | js | `no-class-assign` | mapped | configured | same |
| [suspicious/noCommentText](https://raw.githubusercontent.com/biomejs/biome/%40biomejs/biome%402.2.3/crates/biome_js_analyze/src/lint/suspicious/no_comment_text.rs) | js | `react/jsx-no-comment-textnodes` | absent | configured | same |
| [suspicious/noCompareNegZero](https://raw.githubusercontent.com/biomejs/biome/%40biomejs/biome%402.2.3/crates/biome_js_analyze/src/lint/suspicious/no_compare_neg_zero.rs) | js | `no-compare-neg-zero` | mapped | configured | same |
| [suspicious/noConfusingLabels](https://raw.githubusercontent.com/biomejs/biome/%40biomejs/biome%402.2.3/crates/biome_js_analyze/src/lint/suspicious/no_confusing_labels.rs) | js | `no-labels` | absent | coverage exception | inspired |
| [suspicious/noConfusingVoidType](https://raw.githubusercontent.com/biomejs/biome/%40biomejs/biome%402.2.3/crates/biome_js_analyze/src/lint/suspicious/no_confusing_void_type.rs) | js | `typescript/no-invalid-void-type` | absent | configured | same |
| [suspicious/noConstEnum](https://raw.githubusercontent.com/biomejs/biome/%40biomejs/biome%402.2.3/crates/biome_js_analyze/src/lint/suspicious/no_const_enum.rs) | js | `oxc/no-const-enum` | absent | coverage exception | manual mapping |
| [suspicious/noControlCharactersInRegex](https://raw.githubusercontent.com/biomejs/biome/%40biomejs/biome%402.2.3/crates/biome_js_analyze/src/lint/suspicious/no_control_characters_in_regex.rs) | js | `no-control-regex` | mapped | configured | same |
| [suspicious/noDebugger](https://raw.githubusercontent.com/biomejs/biome/%40biomejs/biome%402.2.3/crates/biome_js_analyze/src/lint/suspicious/no_debugger.rs) | js | `no-debugger` | mapped | configured | same |
| [suspicious/noDocumentCookie](https://raw.githubusercontent.com/biomejs/biome/%40biomejs/biome%402.2.3/crates/biome_js_analyze/src/lint/suspicious/no_document_cookie.rs) | js | `unicorn/no-document-cookie` | absent | configured | same |
| [suspicious/noDoubleEquals](https://raw.githubusercontent.com/biomejs/biome/%40biomejs/biome%402.2.3/crates/biome_js_analyze/src/lint/suspicious/no_double_equals.rs) | js | `eqeqeq` | absent | configured | same |
| [suspicious/noDuplicateAtImportRules](https://raw.githubusercontent.com/biomejs/biome/%40biomejs/biome%402.2.3/crates/biome_css_analyze/src/lint/suspicious/no_duplicate_at_import_rules.rs) | css | none | absent | coverage exception | none |
| [suspicious/noDuplicateCase](https://raw.githubusercontent.com/biomejs/biome/%40biomejs/biome%402.2.3/crates/biome_js_analyze/src/lint/suspicious/no_duplicate_case.rs) | js | `no-duplicate-case` | mapped | configured | same |
| [suspicious/noDuplicateClassMembers](https://raw.githubusercontent.com/biomejs/biome/%40biomejs/biome%402.2.3/crates/biome_js_analyze/src/lint/suspicious/no_duplicate_class_members.rs) | js | `no-dupe-class-members`, `no-dupe-class-members` | mapped | configured | same, same |
| [suspicious/noDuplicateCustomProperties](https://raw.githubusercontent.com/biomejs/biome/%40biomejs/biome%402.2.3/crates/biome_css_analyze/src/lint/suspicious/no_duplicate_custom_properties.rs) | css | none | absent | coverage exception | none |
| [suspicious/noDuplicateElseIf](https://raw.githubusercontent.com/biomejs/biome/%40biomejs/biome%402.2.3/crates/biome_js_analyze/src/lint/suspicious/no_duplicate_else_if.rs) | js | `no-dupe-else-if` | mapped | configured | same |
| [suspicious/noDuplicateFields](https://raw.githubusercontent.com/biomejs/biome/%40biomejs/biome%402.2.3/crates/biome_graphql_analyze/src/lint/suspicious/no_duplicate_fields.rs) | graphql | none | absent | coverage exception | none |
| [suspicious/noDuplicateFontNames](https://raw.githubusercontent.com/biomejs/biome/%40biomejs/biome%402.2.3/crates/biome_css_analyze/src/lint/suspicious/no_duplicate_font_names.rs) | css | none | absent | coverage exception | none |
| [suspicious/noDuplicateJsxProps](https://raw.githubusercontent.com/biomejs/biome/%40biomejs/biome%402.2.3/crates/biome_js_analyze/src/lint/suspicious/no_duplicate_jsx_props.rs) | js | `react/jsx-no-duplicate-props` | absent | configured | same |
| [suspicious/noDuplicateObjectKeys](https://raw.githubusercontent.com/biomejs/biome/%40biomejs/biome%402.2.3/crates/biome_js_analyze/src/lint/suspicious/no_duplicate_object_keys.rs) | js | `no-dupe-keys` | mapped | configured | same |
| [suspicious/noDuplicateParameters](https://raw.githubusercontent.com/biomejs/biome/%40biomejs/biome%402.2.3/crates/biome_js_analyze/src/lint/suspicious/no_duplicate_parameters.rs) | js | none | absent | parser fixture | none |
| [suspicious/noDuplicateProperties](https://raw.githubusercontent.com/biomejs/biome/%40biomejs/biome%402.2.3/crates/biome_css_analyze/src/lint/suspicious/no_duplicate_properties.rs) | css | none | absent | coverage exception | none |
| [suspicious/noDuplicateSelectorsKeyframeBlock](https://raw.githubusercontent.com/biomejs/biome/%40biomejs/biome%402.2.3/crates/biome_css_analyze/src/lint/suspicious/no_duplicate_selectors_keyframe_block.rs) | css | none | absent | coverage exception | none |
| [suspicious/noEmptyBlock](https://raw.githubusercontent.com/biomejs/biome/%40biomejs/biome%402.2.3/crates/biome_css_analyze/src/lint/suspicious/no_empty_block.rs) | css | none | absent | coverage exception | none |
| [suspicious/noEmptyInterface](https://raw.githubusercontent.com/biomejs/biome/%40biomejs/biome%402.2.3/crates/biome_js_analyze/src/lint/suspicious/no_empty_interface.rs) | js | `typescript/no-empty-interface` | absent | coverage exception | inspired |
| [suspicious/noExplicitAny](https://raw.githubusercontent.com/biomejs/biome/%40biomejs/biome%402.2.3/crates/biome_js_analyze/src/lint/suspicious/no_explicit_any.rs) | js | `typescript/no-explicit-any` | absent | configured | same |
| [suspicious/noExtraNonNullAssertion](https://raw.githubusercontent.com/biomejs/biome/%40biomejs/biome%402.2.3/crates/biome_js_analyze/src/lint/suspicious/no_extra_non_null_assertion.rs) | js | `typescript/no-extra-non-null-assertion` | mapped | configured | same |
| [suspicious/noFallthroughSwitchClause](https://raw.githubusercontent.com/biomejs/biome/%40biomejs/biome%402.2.3/crates/biome_js_analyze/src/lint/suspicious/no_fallthrough_switch_clause.rs) | js | `no-fallthrough` | absent | configured | same |
| [suspicious/noFunctionAssign](https://raw.githubusercontent.com/biomejs/biome/%40biomejs/biome%402.2.3/crates/biome_js_analyze/src/lint/suspicious/no_function_assign.rs) | js | `no-func-assign` | mapped | configured | same |
| [suspicious/noGlobalAssign](https://raw.githubusercontent.com/biomejs/biome/%40biomejs/biome%402.2.3/crates/biome_js_analyze/src/lint/suspicious/no_global_assign.rs) | js | `no-global-assign` | mapped | configured | same |
| [suspicious/noGlobalIsFinite](https://raw.githubusercontent.com/biomejs/biome/%40biomejs/biome%402.2.3/crates/biome_js_analyze/src/lint/suspicious/no_global_is_finite.rs) | js | `unicorn/prefer-number-properties` | absent | coverage exception | manual mapping |
| [suspicious/noGlobalIsNan](https://raw.githubusercontent.com/biomejs/biome/%40biomejs/biome%402.2.3/crates/biome_js_analyze/src/lint/suspicious/no_global_is_nan.rs) | js | `unicorn/prefer-number-properties` | absent | coverage exception | manual mapping |
| [suspicious/noImplicitAnyLet](https://raw.githubusercontent.com/biomejs/biome/%40biomejs/biome%402.2.3/crates/biome_js_analyze/src/lint/suspicious/no_implicit_any_let.rs) | js | none | absent | coverage exception | none |
| [suspicious/noImportAssign](https://raw.githubusercontent.com/biomejs/biome/%40biomejs/biome%402.2.3/crates/biome_js_analyze/src/lint/suspicious/no_import_assign.rs) | js | `no-import-assign` | mapped | configured | same |
| [suspicious/noImportantInKeyframe](https://raw.githubusercontent.com/biomejs/biome/%40biomejs/biome%402.2.3/crates/biome_css_analyze/src/lint/suspicious/no_important_in_keyframe.rs) | css | none | absent | coverage exception | none |
| [suspicious/noIrregularWhitespace](https://raw.githubusercontent.com/biomejs/biome/%40biomejs/biome%402.2.3/crates/biome_js_analyze/src/lint/suspicious/no_irregular_whitespace.rs) | js | `no-irregular-whitespace` | mapped | configured | same |
| [suspicious/noLabelVar](https://raw.githubusercontent.com/biomejs/biome/%40biomejs/biome%402.2.3/crates/biome_js_analyze/src/lint/suspicious/no_label_var.rs) | js | `no-label-var` | absent | configured | same |
| [suspicious/noMisleadingCharacterClass](https://raw.githubusercontent.com/biomejs/biome/%40biomejs/biome%402.2.3/crates/biome_js_analyze/src/lint/suspicious/no_misleading_character_class.rs) | js | `no-misleading-character-class` | mapped | configured | same |
| [suspicious/noMisleadingInstantiator](https://raw.githubusercontent.com/biomejs/biome/%40biomejs/biome%402.2.3/crates/biome_js_analyze/src/lint/suspicious/no_misleading_instantiator.rs) | js | `typescript/no-misused-new` | mapped | configured | same |
| [suspicious/noMisrefactoredShorthandAssign](https://raw.githubusercontent.com/biomejs/biome/%40biomejs/biome%402.2.3/crates/biome_js_analyze/src/lint/suspicious/no_misrefactored_shorthand_assign.rs) | js | none | absent | coverage exception | none |
| [suspicious/noOctalEscape](https://raw.githubusercontent.com/biomejs/biome/%40biomejs/biome%402.2.3/crates/biome_js_analyze/src/lint/suspicious/no_octal_escape.rs) | js | none | absent | parser fixture | none |
| [suspicious/noPrototypeBuiltins](https://raw.githubusercontent.com/biomejs/biome/%40biomejs/biome%402.2.3/crates/biome_js_analyze/src/lint/suspicious/no_prototype_builtins.rs) | js | `no-prototype-builtins`, `prefer-object-has-own` | absent | configured | same, same |
| [suspicious/noQuickfixBiome](https://raw.githubusercontent.com/biomejs/biome/%40biomejs/biome%402.2.3/crates/biome_json_analyze/src/lint/suspicious/no_quickfix_biome.rs) | json | none | absent | tool removed | none |
| [suspicious/noRedeclare](https://raw.githubusercontent.com/biomejs/biome/%40biomejs/biome%402.2.3/crates/biome_js_analyze/src/lint/suspicious/no_redeclare.rs) | js | `no-redeclare`, `no-redeclare` | absent | configured | same, same |
| [suspicious/noRedundantUseStrict](https://raw.githubusercontent.com/biomejs/biome/%40biomejs/biome%402.2.3/crates/biome_js_analyze/src/lint/suspicious/no_redundant_use_strict.rs) | js | none | absent | coverage exception | none |
| [suspicious/noSelfCompare](https://raw.githubusercontent.com/biomejs/biome/%40biomejs/biome%402.2.3/crates/biome_js_analyze/src/lint/suspicious/no_self_compare.rs) | js | `no-self-compare` | absent | configured | same |
| [suspicious/noShadowRestrictedNames](https://raw.githubusercontent.com/biomejs/biome/%40biomejs/biome%402.2.3/crates/biome_js_analyze/src/lint/suspicious/no_shadow_restricted_names.rs) | js | `no-shadow-restricted-names` | mapped | configured | same |
| [suspicious/noShorthandPropertyOverrides](https://raw.githubusercontent.com/biomejs/biome/%40biomejs/biome%402.2.3/crates/biome_css_analyze/src/lint/suspicious/no_shorthand_property_overrides.rs) | css | none | absent | coverage exception | none |
| [suspicious/noSparseArray](https://raw.githubusercontent.com/biomejs/biome/%40biomejs/biome%402.2.3/crates/biome_js_analyze/src/lint/suspicious/no_sparse_array.rs) | js | `no-sparse-arrays` | mapped | configured | same |
| [suspicious/noSuspiciousSemicolonInJsx](https://raw.githubusercontent.com/biomejs/biome/%40biomejs/biome%402.2.3/crates/biome_js_analyze/src/lint/suspicious/no_suspicious_semicolon_in_jsx.rs) | js | none | absent | coverage exception | none |
| [suspicious/noTemplateCurlyInString](https://raw.githubusercontent.com/biomejs/biome/%40biomejs/biome%402.2.3/crates/biome_js_analyze/src/lint/suspicious/no_template_curly_in_string.rs) | js | `no-template-curly-in-string` | absent | configured | same |
| [suspicious/noThenProperty](https://raw.githubusercontent.com/biomejs/biome/%40biomejs/biome%402.2.3/crates/biome_js_analyze/src/lint/suspicious/no_then_property.rs) | js | `unicorn/no-thenable` | absent | configured | same |
| [suspicious/noTsIgnore](https://raw.githubusercontent.com/biomejs/biome/%40biomejs/biome%402.2.3/crates/biome_js_analyze/src/lint/suspicious/no_ts_ignore.rs) | js | `typescript/ban-ts-comment` | absent | coverage exception | inspired |
| [suspicious/noUnknownAtRules](https://raw.githubusercontent.com/biomejs/biome/%40biomejs/biome%402.2.3/crates/biome_css_analyze/src/lint/suspicious/no_unknown_at_rules.rs) | css | none | absent | coverage exception | none |
| [suspicious/noUnsafeDeclarationMerging](https://raw.githubusercontent.com/biomejs/biome/%40biomejs/biome%402.2.3/crates/biome_js_analyze/src/lint/suspicious/no_unsafe_declaration_merging.rs) | js | `typescript/no-unsafe-declaration-merging` | mapped | configured | same |
| [suspicious/noUnsafeNegation](https://raw.githubusercontent.com/biomejs/biome/%40biomejs/biome%402.2.3/crates/biome_js_analyze/src/lint/suspicious/no_unsafe_negation.rs) | js | `no-unsafe-negation` | mapped | configured | same |
| [suspicious/noUselessEscapeInString](https://raw.githubusercontent.com/biomejs/biome/%40biomejs/biome%402.2.3/crates/biome_js_analyze/src/lint/suspicious/no_useless_escape_in_string.rs) | js | `no-useless-escape` | mapped | coverage exception | manual mapping |
| [suspicious/noUselessRegexBackrefs](https://raw.githubusercontent.com/biomejs/biome/%40biomejs/biome%402.2.3/crates/biome_js_analyze/src/lint/suspicious/no_useless_regex_backrefs.rs) | js | `no-useless-backreference` | mapped | configured | same |
| [suspicious/noWith](https://raw.githubusercontent.com/biomejs/biome/%40biomejs/biome%402.2.3/crates/biome_js_analyze/src/lint/suspicious/no_with.rs) | js | `no-with` | mapped | configured | same |
| [suspicious/useAdjacentOverloadSignatures](https://raw.githubusercontent.com/biomejs/biome/%40biomejs/biome%402.2.3/crates/biome_js_analyze/src/lint/suspicious/use_adjacent_overload_signatures.rs) | js | `typescript/adjacent-overload-signatures` | absent | configured | same |
| [suspicious/useBiomeIgnoreFolder](https://raw.githubusercontent.com/biomejs/biome/%40biomejs/biome%402.2.3/crates/biome_json_analyze/src/lint/suspicious/use_biome_ignore_folder.rs) | json | none | absent | tool removed | none |
| [suspicious/useDefaultSwitchClauseLast](https://raw.githubusercontent.com/biomejs/biome/%40biomejs/biome%402.2.3/crates/biome_js_analyze/src/lint/suspicious/use_default_switch_clause_last.rs) | js | `default-case-last` | absent | configured | same |
| [suspicious/useGetterReturn](https://raw.githubusercontent.com/biomejs/biome/%40biomejs/biome%402.2.3/crates/biome_js_analyze/src/lint/suspicious/use_getter_return.rs) | js | `getter-return` | mapped | configured | same |
| [suspicious/useGoogleFontDisplay](https://raw.githubusercontent.com/biomejs/biome/%40biomejs/biome%402.2.3/crates/biome_js_analyze/src/lint/suspicious/use_google_font_display.rs) | js | `nextjs/google-font-display` | absent | configured | same |
| [suspicious/useIsArray](https://raw.githubusercontent.com/biomejs/biome/%40biomejs/biome%402.2.3/crates/biome_js_analyze/src/lint/suspicious/use_is_array.rs) | js | `unicorn/no-instanceof-array` | absent | configured | same |
| [suspicious/useIterableCallbackReturn](https://raw.githubusercontent.com/biomejs/biome/%40biomejs/biome%402.2.3/crates/biome_js_analyze/src/lint/suspicious/use_iterable_callback_return.rs) | js | `array-callback-return` | absent | configured | same |
| [suspicious/useNamespaceKeyword](https://raw.githubusercontent.com/biomejs/biome/%40biomejs/biome%402.2.3/crates/biome_js_analyze/src/lint/suspicious/use_namespace_keyword.rs) | js | `typescript/prefer-namespace-keyword` | mapped | configured | same |

## Remaining exceptions

CSS and GraphQL checks have no Oxlint language implementation; their individual rows remain coverage exceptions.
Biome self-configuration checks no longer apply after removing Biome configuration.
Other unsupported JavaScript rows remain actual gaps, not formatting equivalents.
Oxfmt preserves hexadecimal and exponent property keys, so useSimpleNumberKeys remains unsupported.

Historical organizeImports merged imports, sorted them, and separated type imports.
Current Oxfmt configuration does not claim those semantics.
Automatic import organization is deliberately removed from this migration's tooling contract.

## Primary sources

- [Biome 2.2.3 recommendation indexes](https://raw.githubusercontent.com/biomejs/biome/%40biomejs/biome%402.2.3/crates/biome_configuration/src/analyzer/linter/rules.rs)
- [ESLint 9.38.0 recommended rules](https://github.com/eslint/eslint/blob/v9.38.0/packages/js/src/configs/eslint-recommended.js)
- [TypeScript ESLint 8.46.2 recommended rules](https://github.com/typescript-eslint/typescript-eslint/blob/v8.46.2/packages/typescript-eslint/src/configs/recommended.ts)
- [Migration evidence](tooling-10.md)
