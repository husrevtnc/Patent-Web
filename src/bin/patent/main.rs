//! `patent` binary — thin CLI/TUI shell over the `patent` library.

mod cli;
mod config;
mod pipeline;
mod tui;

use clap::{CommandFactory, Parser};
use cli::Cli;
use patent::query::{build_query, validate_idea};
use std::io::IsTerminal;

const OLLAMA_CLOUD_API_BASE: &str = "https://ollama.com/v1";

fn is_ollama_cloud_api(base: &str) -> bool {
    base.trim_end_matches('/') == OLLAMA_CLOUD_API_BASE
}

fn resolve_api_base(configured: Option<String>, ollama_api_key: Option<&str>) -> Option<String> {
    configured.or_else(|| {
        ollama_api_key
            .filter(|key| !key.trim().is_empty())
            .map(|_| OLLAMA_CLOUD_API_BASE.to_string())
    })
}

fn resolve_api_key(
    configured: Option<String>,
    ollama_api_key: Option<String>,
    openai_api_key: Option<String>,
    use_ollama_cloud: bool,
) -> Option<String> {
    configured
        .or(if use_ollama_cloud {
            ollama_api_key
        } else {
            None
        })
        .or(openai_api_key)
}

fn default_model_for_api(base: Option<&str>) -> Option<&'static str> {
    base.filter(|url| is_ollama_cloud_api(url))
        .map(|_| "beam:cloud")
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let args = Cli::parse();

    if let Some(shell) = args.completions {
        clap_complete::generate(shell, &mut Cli::command(), "patent", &mut std::io::stdout());
        return Ok(());
    }

    if args.list_sources {
        for s in patent::Source::all() {
            println!("{:<22} {}", s.kebab_name(), s);
        }
        return Ok(());
    }

    let sources_include: Option<std::collections::HashSet<patent::Source>> =
        if args.sources.is_empty() {
            None
        } else {
            let mut set = std::collections::HashSet::new();
            for name in &args.sources {
                set.insert(
                    name.parse::<patent::Source>()
                        .map_err(|e| anyhow::anyhow!(e))?,
                );
            }
            Some(set)
        };

    let sources_exclude: std::collections::HashSet<patent::Source> = {
        let mut set = std::collections::HashSet::new();
        for name in &args.exclude {
            set.insert(
                name.parse::<patent::Source>()
                    .map_err(|e| anyhow::anyhow!(e))?,
            );
        }
        set
    };

    // Load config and resolve backend settings before the no-idea check so the
    // interactive TUI gets the configured LLM backend when no idea is on the CLI.
    let cfg = config::load()?;

    // Resolve: CLI flag / env var (via clap) > config file > built-in default.
    // OPENAI_API_KEY is a well-known fallback for api_key only (checked last).
    let ollama_api_key = std::env::var("OLLAMA_API_KEY")
        .ok()
        .filter(|key| !key.trim().is_empty());
    let api_base = resolve_api_base(args.api_base.or(cfg.api_base), ollama_api_key.as_deref());
    let ollama_cloud_api = api_base.as_deref().is_some_and(is_ollama_cloud_api);
    let api_key_explicit = args.api_key.is_some()
        || cfg.api_key.is_some()
        || (ollama_cloud_api && ollama_api_key.is_some());
    let api_key = resolve_api_key(
        args.api_key.or(cfg.api_key),
        ollama_api_key,
        std::env::var("OPENAI_API_KEY").ok(),
        ollama_cloud_api,
    );
    let model = args
        .model
        .or(cfg.model)
        .or_else(|| default_model_for_api(api_base.as_deref()).map(str::to_string));

    if !args.fast && api_base.is_some() && model.is_none() {
        anyhow::bail!(
            "api_base is set but no model was specified. \
             Pass --model <NAME>, set PATENT_MODEL, or add `model = \"...\"` to \
             your patent config file (its location is shown in the README)."
        );
    }
    if api_key_explicit && api_base.is_none() {
        eprintln!("warning: api_key has no effect without api_base; using local Ollama.");
    }
    if args.fast && api_base.is_some() {
        eprintln!("warning: --fast skips the LLM, so api_base has no effect.");
    }
    if let Some(base) = &api_base {
        if !args.fast {
            eprintln!(
                "note: --api-base sends your search query to {base} to generate the verdict; \
                 the default local Ollama backend and --fast keep it on your machine."
            );
        }
    }

    let idea = match args.idea {
        Some(i) => i,
        None => {
            if args.json {
                anyhow::bail!("--json requires an idea argument.");
            }
            if !std::io::stdout().is_terminal() {
                anyhow::bail!("No idea provided. Usage: patent \"your dev-tool idea here\"");
            }
            return tui::run_interactive(tui::TuiCfg {
                api_base,
                api_key,
                model,
                fast: args.fast,
                keyword_only: args.keyword_only,
                sources_include: sources_include.clone(),
                sources_exclude: sources_exclude.clone(),
            })
            .await;
        }
    };
    validate_idea(&idea).map_err(anyhow::Error::msg)?;

    let query = build_query(&idea);
    eprintln!("Searching for prior art: \"{}\"", idea);
    eprintln!("   keywords: {}", query.keywords.join(", "));

    if !args.keyword_only && !patent::rank::model_is_cached() {
        eprintln!(
            "patent: downloading the embedding model for local semantic search (~80 MB, one-time)..."
        );
    }

    let pipeline_cfg = pipeline::PipelineCfg {
        api_base: api_base.clone(),
        api_key: api_key.clone(),
        model: model.clone(),
        fast: args.fast || args.print_prompt,
        keyword_only: args.keyword_only,
        limit: args.limit as usize,
        sources_include: sources_include.clone(),
        sources_exclude: sources_exclude.clone(),
    };

    let t_start = std::time::Instant::now();
    let result = pipeline::run(&idea, &pipeline_cfg, |msg| eprintln!("{msg}")).await?;

    if args.print_prompt {
        let prompt =
            patent::verdict::build_prompt(&query, &result.matches, &result.verdict.sources_checked);
        print!("{prompt}");
        return Ok(());
    }

    let verdict = result.verdict;
    let ranked = result.matches;

    eprintln!("total: {:.1}s", t_start.elapsed().as_secs_f64());

    // ── Phase 4: output ─────────────────────────────────────────────────
    // The TUI needs a real terminal; when stdout is piped or redirected, fall
    // back to JSON rather than panicking on terminal initialization.
    let exit_code = verdict.level.exit_code();

    let want_json = args.json || !std::io::stdout().is_terminal();
    if want_json {
        if !args.json {
            eprintln!(
                "note: stdout is not a terminal — emitting JSON (pass --json to silence this)."
            );
        }
        #[derive(serde::Serialize)]
        struct Output {
            schema_version: u32,
            query: String,
            verdict: patent::Verdict,
            matches: Vec<patent::Match>,
        }
        let output = Output {
            schema_version: 1,
            query: idea.clone(),
            verdict,
            matches: ranked,
        };
        println!("{}", serde_json::to_string_pretty(&output)?);
    } else {
        tui::run_with_results(
            &idea,
            verdict,
            ranked,
            tui::TuiCfg {
                api_base,
                api_key,
                model,
                fast: args.fast,
                keyword_only: args.keyword_only,
                sources_include,
                sources_exclude,
            },
        )
        .await?;
    }

    std::process::exit(exit_code)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ollama_cloud_key_selects_cloud_api_but_explicit_base_wins() {
        assert_eq!(
            resolve_api_base(None, Some("cloud-key")),
            Some(OLLAMA_CLOUD_API_BASE.to_string())
        );
        assert_eq!(resolve_api_base(None, Some("  ")), None);
        assert_eq!(
            resolve_api_base(Some("https://proxy.example/v1".into()), Some("cloud-key")),
            Some("https://proxy.example/v1".into())
        );
    }

    #[test]
    fn ollama_cloud_key_is_only_selected_for_the_cloud_endpoint() {
        assert_eq!(
            resolve_api_key(None, Some("ollama-key".into()), None, true),
            Some("ollama-key".into())
        );
        assert_eq!(
            resolve_api_key(
                None,
                Some("ollama-key".into()),
                Some("openai-key".into()),
                false
            ),
            Some("openai-key".into())
        );
        assert_eq!(
            resolve_api_key(
                Some("configured-key".into()),
                Some("ollama-key".into()),
                None,
                true
            ),
            Some("configured-key".into())
        );
    }

    #[test]
    fn ollama_cloud_api_selects_beam_by_default() {
        assert_eq!(
            default_model_for_api(Some("https://ollama.com/v1")),
            Some("beam:cloud")
        );
        assert_eq!(
            default_model_for_api(Some("https://ollama.com/v1/")),
            Some("beam:cloud")
        );
        assert_eq!(
            default_model_for_api(Some("https://api.openai.com/v1")),
            None
        );
        assert_eq!(default_model_for_api(None), None);
    }

    #[test]
    fn validate_idea_accepts_a_normal_idea() {
        assert!(validate_idea("a cli tool to kill a process on a given port").is_ok());
    }

    #[test]
    fn validate_idea_rejects_empty_and_vague() {
        assert!(validate_idea("").is_err());
        assert!(validate_idea("   ").is_err());
        assert!(validate_idea("ab cd").is_err());
        // Regression: short ASCII gibberish must NOT slip through the CJK
        // fallback (which only applies to non-ASCII, space-free scripts).
        assert!(validate_idea("foobar").is_err());
        assert!(validate_idea("123456").is_err());
        assert!(validate_idea("hello world").is_err());
    }

    #[test]
    fn validate_idea_rejects_fewer_than_two_non_stopwords() {
        // Zero non-stopwords — build_query produces empty keywords.
        assert!(validate_idea("the and for are but not").is_err());
        assert!(validate_idea("those would other great found first").is_err());
        // One non-stopword — "tool" alone generates noise results for any query.
        assert!(validate_idea("what does this tool have with them").is_err());
        assert!(validate_idea("the and for tool are but not").is_err());
        // Two non-stopwords — acceptable minimum.
        assert!(validate_idea("the and for tool linting what").is_ok());
    }

    #[test]
    fn validate_idea_accepts_non_ascii_scripts() {
        // Cyrillic (space-delimited) and CJK (no spaces) must both be accepted.
        assert!(validate_idea("инструмент для управления процессами на порту").is_ok());
        assert!(validate_idea("端口杀手命令行工具").is_ok());
    }
}
