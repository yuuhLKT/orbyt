use serde::Serialize;
use std::{
    fs::{self, File, FileType},
    io::Read,
    path::{Path, PathBuf},
};

const MAX_FILES: usize = 128;
const MAX_DIRECTORY_ENTRIES: usize = 256;
const MAX_FILE_BYTES: usize = 64 * 1024;
const MAX_TOTAL_BYTES: usize = 1024 * 1024;
const MAX_NAME_CHARS: usize = 128;
const MAX_DESCRIPTION_CHARS: usize = 240;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowResource {
    pub name: String,
    pub relative_path: String,
    pub description: String,
    pub readable: bool,
    pub parseable: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectWorkflowResources {
    pub working_directory: String,
    pub discovery_note: String,
    pub counts: ResourceCounts,
    pub skills: Vec<WorkflowResource>,
    pub commands: Vec<WorkflowResource>,
    pub agents: Vec<WorkflowResource>,
    pub instructions: Vec<WorkflowResource>,
    pub configs: Vec<WorkflowResource>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResourceCounts {
    pub skills: usize,
    pub commands: usize,
    pub agents: usize,
    pub instructions: usize,
    pub configs: usize,
}

#[derive(Default)]
struct Budget {
    files: usize,
    bytes: usize,
}

impl Budget {
    fn available(&self) -> bool {
        self.files < MAX_FILES && self.bytes < MAX_TOTAL_BYTES
    }
}

pub fn discover(root: &Path) -> ProjectWorkflowResources {
    let mut result = ProjectWorkflowResources {
        working_directory: root.to_string_lossy().into_owned(),
        discovery_note: "These files were found and checked by Orbyt; this does not prove an ACP session loaded each resource."
            .into(),
        counts: ResourceCounts {
            skills: 0,
            commands: 0,
            agents: 0,
            instructions: 0,
            configs: 0,
        },
        skills: Vec::new(),
        commands: Vec::new(),
        agents: Vec::new(),
        instructions: Vec::new(),
        configs: Vec::new(),
    };
    let mut budget = Budget::default();

    add_file(
        root,
        Path::new("AGENTS.md"),
        "AGENTS.md",
        &mut result.instructions,
        &mut budget,
        false,
    );
    add_markdown_directory(
        root,
        ".opencode/skills",
        &mut result.skills,
        &mut budget,
        true,
    );
    add_markdown_directory(
        root,
        ".opencode/commands",
        &mut result.commands,
        &mut budget,
        false,
    );
    add_markdown_directory(
        root,
        ".opencode/agents",
        &mut result.agents,
        &mut budget,
        false,
    );
    let plugins = root.join("plugins");
    if is_real_directory(&plugins) {
        if let Ok(entries) = fs::read_dir(&plugins) {
            let mut entries = entries
                .filter_map(Result::ok)
                .take(MAX_DIRECTORY_ENTRIES)
                .collect::<Vec<_>>();
            entries.sort_by_key(|entry| entry.file_name());
            for entry in entries {
                if !budget.available() {
                    break;
                }
                let Ok(kind) = entry.file_type() else {
                    continue;
                };
                if kind.is_dir() {
                    let rel = PathBuf::from("plugins")
                        .join(entry.file_name())
                        .join("AGENTS.md");
                    add_file(
                        root,
                        &rel,
                        &rel.to_string_lossy(),
                        &mut result.instructions,
                        &mut budget,
                        false,
                    );
                }
            }
        }
    }

    for rel in [
        "opencode.json",
        "opencode.jsonc",
        ".opencode/opencode.json",
        ".opencode/opencode.jsonc",
    ] {
        if !budget.available() {
            break;
        }
        add_file(
            root,
            Path::new(rel),
            rel,
            &mut result.configs,
            &mut budget,
            true,
        );
    }
    result.counts = ResourceCounts {
        skills: result.skills.len(),
        commands: result.commands.len(),
        agents: result.agents.len(),
        instructions: result.instructions.len(),
        configs: result.configs.len(),
    };
    result
}

fn is_real_directory(path: &Path) -> bool {
    fs::symlink_metadata(path).is_ok_and(|metadata| metadata.file_type().is_dir())
}

fn add_markdown_directory(
    root: &Path,
    relative: &str,
    output: &mut Vec<WorkflowResource>,
    budget: &mut Budget,
    skills: bool,
) {
    let directory = root.join(relative);
    if !is_real_directory(&directory) {
        return;
    }
    let Ok(entries) = fs::read_dir(directory) else {
        return;
    };
    let mut entries = entries
        .filter_map(Result::ok)
        .take(MAX_DIRECTORY_ENTRIES)
        .collect::<Vec<_>>();
    entries.sort_by_key(|entry| entry.file_name());
    for entry in entries {
        if !budget.available() {
            break;
        }
        let Ok(kind) = entry.file_type() else {
            continue;
        };
        if skills {
            if !kind.is_dir() {
                continue;
            }
            let rel = PathBuf::from(relative)
                .join(entry.file_name())
                .join("SKILL.md");
            add_file(
                root,
                &rel,
                &entry.file_name().to_string_lossy(),
                output,
                budget,
                false,
            );
        } else if kind.is_file()
            && entry
                .path()
                .extension()
                .is_some_and(|extension| extension == "md")
        {
            let rel = PathBuf::from(relative).join(entry.file_name());
            add_file(
                root,
                &rel,
                &entry.file_name().to_string_lossy(),
                output,
                budget,
                false,
            );
        }
    }
}

fn add_file(
    root: &Path,
    relative: &Path,
    display_name: &str,
    output: &mut Vec<WorkflowResource>,
    budget: &mut Budget,
    config: bool,
) {
    if !budget.available() {
        return;
    }
    let path = root.join(relative);
    let Ok(metadata) = fs::symlink_metadata(&path) else {
        return;
    };
    let kind: FileType = metadata.file_type();
    if !kind.is_file() || metadata.len() > MAX_FILE_BYTES as u64 {
        return;
    }
    budget.files += 1;
    let available = MAX_TOTAL_BYTES
        .saturating_sub(budget.bytes)
        .min(MAX_FILE_BYTES);
    let mut bytes = Vec::with_capacity(metadata.len() as usize);
    let read_result =
        File::open(&path).and_then(|file| file.take(available as u64 + 1).read_to_end(&mut bytes));
    let within_limit = read_result.is_ok() && bytes.len() <= available;
    if within_limit {
        budget.bytes += bytes.len();
    }
    let text = within_limit
        .then(|| std::str::from_utf8(&bytes).ok())
        .flatten();
    let parseable = text.is_some_and(|text| {
        if config {
            serde_json::from_str::<serde_json::Value>(text).is_ok()
        } else {
            true
        }
    });
    let description = text
        .map(|text| extract_description(text, config))
        .unwrap_or_default();
    let relative_path = relative.to_string_lossy().into_owned();
    output.push(WorkflowResource {
        name: bounded(display_name, MAX_NAME_CHARS),
        relative_path: bounded(&relative_path, MAX_NAME_CHARS * 4),
        description,
        readable: text.is_some(),
        parseable,
    });
}

fn extract_description(text: &str, config: bool) -> String {
    let value = if config {
        serde_json::from_str::<serde_json::Value>(text)
            .ok()
            .and_then(|json| {
                json.get("description")
                    .and_then(serde_json::Value::as_str)
                    .map(str::to_owned)
            })
            .unwrap_or_default()
    } else {
        let mut lines = text.lines().peekable();
        if lines.peek().is_some_and(|line| line.trim() == "---") {
            lines.next();
            for line in lines.by_ref() {
                if line.trim() == "---" {
                    break;
                }
                if let Some((key, value)) = line.split_once(':') {
                    if key.trim() == "description" {
                        return bounded(
                            value
                                .trim()
                                .trim_matches(|character| character == '"' || character == '\''),
                            MAX_DESCRIPTION_CHARS,
                        );
                    }
                }
            }
        }
        String::new()
    };
    bounded(value.trim(), MAX_DESCRIPTION_CHARS)
}

fn bounded(value: &str, max_chars: usize) -> String {
    value.chars().take(max_chars).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn discovers_only_known_project_resources_and_reports_summaries() {
        let temp = tempfile::tempdir().expect("temp dir");
        let root = temp.path();
        fs::create_dir_all(root.join(".opencode/skills/review")).expect("skill dir");
        fs::create_dir_all(root.join(".opencode/commands")).expect("commands dir");
        fs::create_dir_all(root.join(".opencode/agents")).expect("agents dir");
        fs::create_dir_all(root.join("plugins/demo")).expect("plugin dir");
        fs::write(root.join("AGENTS.md"), "# Rules\nUseful project guidance")
            .expect("instructions");
        fs::write(
            root.join(".opencode/skills/review/SKILL.md"),
            "---\ndescription: Reviews changes\n---\nprivate prompt body",
        )
        .expect("skill");
        fs::write(root.join(".opencode/commands/check.md"), "Run checks").expect("command");
        fs::write(
            root.join(".opencode/agents/helper.md"),
            "Agent instructions",
        )
        .expect("agent");
        fs::write(root.join("plugins/demo/AGENTS.md"), "Plugin guidance")
            .expect("plugin instructions");
        fs::write(
            root.join("opencode.json"),
            r#"{"description":"Project config"}"#,
        )
        .expect("config");
        fs::write(root.join(".opencode/commands/ignored.txt"), "ignored").expect("ignored file");

        let resources = discover(root);
        assert_eq!(resources.instructions.len(), 2);
        assert_eq!(resources.skills.len(), 1);
        assert_eq!(resources.commands.len(), 1);
        assert_eq!(resources.agents.len(), 1);
        assert_eq!(resources.configs.len(), 1);
        assert_eq!(resources.counts.skills, resources.skills.len());
        assert_eq!(resources.skills[0].description, "Reviews changes");
        assert!(!resources.skills[0]
            .description
            .contains("private prompt body"));
        assert!(resources.configs[0].readable && resources.configs[0].parseable);
    }

    #[cfg(unix)]
    #[test]
    fn skips_symlink_resources_and_bounds_oversized_files() {
        use std::os::unix::fs::symlink;
        let temp = tempfile::tempdir().expect("temp dir");
        let root = temp.path();
        fs::create_dir_all(root.join(".opencode/agents")).expect("agents");
        let outside = root.join("outside.md");
        fs::write(&outside, "external").expect("outside");
        symlink(outside, root.join(".opencode/agents/linked.md")).expect("symlink");
        fs::write(
            root.join(".opencode/agents/large.md"),
            vec![b'x'; MAX_FILE_BYTES + 1],
        )
        .expect("large");
        assert!(discover(root).agents.is_empty());
    }
}
