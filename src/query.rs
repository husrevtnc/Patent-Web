//! Query validation and normalization shared by the CLI and web front ends.

use crate::Query;

const STOPWORDS: &[&str] = &[
    "the", "and", "for", "are", "but", "not", "you", "all", "can", "had", "her", "was", "one",
    "our", "out", "has", "its", "let", "may", "who", "did", "get", "got", "how", "his", "him",
    "she", "also", "been", "call", "each", "from", "have", "into", "just", "like", "long", "make",
    "many", "more", "most", "much", "must", "name", "only", "over", "some", "such", "than", "that",
    "them", "then", "they", "this", "very", "when", "what", "with", "will", "your", "which",
    "about", "after", "being", "could", "every", "first", "found", "great", "where", "these",
    "their", "there", "those", "would", "other", "should", "before", "between", "best", "near",
    "here", "well", "does", "were",
];

/// Apply the CLI's input checks before either front end starts a search.
pub fn validate_idea(idea: &str) -> Result<(), String> {
    let trimmed = idea.trim();
    if trimmed.is_empty() {
        return Err("Please provide a dev-tool idea to search for.".into());
    }

    let meaningful: Vec<String> = trimmed
        .split_whitespace()
        .filter(|w| w.chars().filter(|c| c.is_alphanumeric()).count() >= 3)
        .map(str::to_lowercase)
        .collect();

    let space_delimited = trimmed.split_whitespace().count() >= 3;
    let cjk_like = trimmed
        .chars()
        .filter(|c| c.is_alphanumeric() && !c.is_ascii())
        .count();
    if !space_delimited && cjk_like >= 2 {
        return Ok(());
    }

    if meaningful.len() < 3 {
        return Err("Too vague — describe a specific software tool or feature, e.g.\n  patent \"CLI tool that kills a process on a given port\"".into());
    }
    let unique: std::collections::HashSet<&str> = meaningful.iter().map(String::as_str).collect();
    if unique.len() < 3 {
        return Err("Too repetitive — describe what the tool does, e.g.\n  patent \"CLI tool that kills a process on a given port\"".into());
    }
    let non_stopword_count = meaningful
        .iter()
        .filter(|word| !STOPWORDS.contains(&word.as_str()))
        .count();
    if non_stopword_count < 2 {
        return Err("Too vague — describe a specific software tool or feature, e.g.\n  patent \"CLI tool that kills a process on a given port\"".into());
    }
    Ok(())
}

fn strip_punctuation(word: &str) -> String {
    word.chars()
        .filter(|c| c.is_alphanumeric() || *c == '-')
        .collect()
}

/// Build the exact normalized query used for source matching and ranking.
pub fn build_query(idea: &str) -> Query {
    let keywords = idea
        .split_whitespace()
        .map(|word| strip_punctuation(&word.to_lowercase()))
        .filter(|word| word.len() > 2 && !STOPWORDS.contains(&word.as_str()))
        .collect();
    Query {
        idea: idea.to_string(),
        keywords,
    }
}
