"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const node_child_process_1 = require("node:child_process");
const utils_1 = require("./utils");
const prompt_1 = require("./prompt");
// Configuration with robust defaults and validation
const config = {
    useChinese: false,
    language: "English",
    promptGenre: process.env.INPUT_PROMPT_GENRE?.trim() || "",
    reviewersPrompt: process.env.INPUT_REVIEWERS_PROMPT?.trim() || "",
    includeFiles: (0, utils_1.split_message)(process.env.INPUT_INCLUDE_FILES || ""),
    excludeFiles: (0, utils_1.split_message)(process.env.INPUT_EXCLUDE_FILES || ""),
    reviewPullRequest: process.env.INPUT_REVIEW_PULL_REQUEST?.toLowerCase() === "true",
    maxRetries: 3,
    retryDelay: 2000,
    timeout: 30000, // 30 seconds
};
const systemPrompt = config.reviewersPrompt || (0, prompt_1.take_system_prompt)(config.promptGenre, config.language);
// Validate required environment variables
function validateEnvironment() {
    const url = process.env.INPUT_HOST?.trim();
    const model = process.env.INPUT_MODEL?.trim();
    if (!url) {
        console.error("❌ ERROR: HOST input is required but not provided");
        console.error("   Please set the INPUT_HOST environment variable with your Ollama endpoint URL");
        process.exit(1);
    }
    if (!model) {
        console.error("❌ ERROR: MODEL input is required but not provided");
        console.error("   Please set the INPUT_MODEL environment variable with your model name");
        process.exit(1);
    }
    // Validate URL format
    try {
        new URL(url);
    }
    catch (error) {
        console.error(`❌ ERROR: Invalid URL format for HOST: ${url}`);
        console.error(`   Error: ${error instanceof Error ? error.message : String(error)}`);
        process.exit(1);
    }
    console.log(`✅ Configuration validated:`);
    console.log(`   - Host: ${url}`);
    console.log(`   - Model: ${model}`);
    console.log(`   - Review Pull Request: ${config.reviewPullRequest}`);
    return { url, model };
}
const { url, model } = validateEnvironment();
// Utility function for retrying operations
async function withRetry(operation, operationName, maxRetries = config.maxRetries) {
    let lastError;
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            console.log(`🔄 Attempting ${operationName} (attempt ${attempt}/${maxRetries})`);
            return await operation();
        }
        catch (error) {
            lastError = error;
            console.error(`❌ Attempt ${attempt} failed for ${operationName}:`);
            console.error(`   Error: ${lastError.message}`);
            if (attempt < maxRetries) {
                console.log(`⏳ Waiting ${config.retryDelay}ms before retry...`);
                await new Promise(resolve => setTimeout(resolve, config.retryDelay));
            }
        }
    }
    console.error(`💥 All ${maxRetries} attempts failed for ${operationName}`);
    throw lastError;
}
// Enhanced comment posting with better error handling
async function pushComments(message) {
    if (!process.env.INPUT_PULL_REQUEST_NUMBER) {
        console.log("📝 No pull request number provided, logging comment instead:");
        console.log("─".repeat(50));
        console.log(message);
        console.log("─".repeat(50));
        return { id: "local-log", success: true };
    }
    const pullRequestNumber = process.env.INPUT_PULL_REQUEST_NUMBER;
    const repository = process.env.INPUT_REPOSITORY;
    const token = process.env.INPUT_TOKEN;
    if (!repository || !token) {
        throw new Error("Missing required environment variables: INPUT_REPOSITORY or INPUT_TOKEN");
    }
    const apiUrl = process.env.GITHUB_API_URL || "https://api.github.com";
    const isGitea = apiUrl.includes('/api/v1') || apiUrl.includes('gitea');
    const endpoint = `${apiUrl}/repos/${process.env.INPUT_REPOSITORY}/issues/${process.env.INPUT_PULL_REQUEST_NUMBER}/comments`;
    console.log(`📤 Posting comment to PR #${pullRequestNumber} in ${repository}`);
    console.log('API Details:');
    console.log('- Endpoint:', endpoint);
    console.log('- Is Gitea:', isGitea);
    console.log('- Has Token:', !!process.env.INPUT_TOKEN);
    return await withRetry(async () => {
        return await (0, utils_1.post)({
            url: endpoint,
            body: { body: message },
            header: {
                'Authorization': `token ${token}`,
                'Accept': 'application/vnd.github.v3+json',
                'User-Agent': 'AI-Review-Bot'
            }
        });
    }, "push comment");
}
// Enhanced AI generation with detailed error handling
async function aiGenerate({ host, token, prompt, model, system }) {
    if (!prompt?.trim()) {
        throw new Error("Empty or invalid prompt provided to AI generation");
    }
    const requestData = {
        prompt: prompt.trim(),
        model: model,
        stream: false,
        system: system || systemPrompt,
        options: {
            tfs_z: 1.5,
            top_k: 30,
            top_p: 0.8,
            temperature: 0.7,
            num_ctx: 10240,
        }
    };
    console.log(`🤖 Generating AI review for ${prompt.length} characters of content`);
    console.log(`   - Model: ${model}`);
    console.log(`   - Host: ${host}`);
    return await withRetry(async () => {
        const response = await (0, utils_1.post)({
            url: `${host}/api/generate`,
            body: requestData,
            header: {
                'Authorization': token ? `Bearer ${token}` : "",
                'Content-Type': 'application/json'
            }
        });
        // Validate response structure
        if (!response) {
            throw new Error("Received empty response from AI service");
        }
        if (response.error) {
            throw new Error(`AI service error: ${response.error}`);
        }
        if (response.detail) {
            throw new Error(`AI service detail error: ${JSON.stringify(response.detail)}`);
        }
        if (!response.response) {
            throw new Error("AI service returned no response content");
        }
        return response;
    }, "AI generation", 2); // Fewer retries for AI calls
}
// Enhanced diff context retrieval with better error handling
async function getPrDiffContext() {
    const baseRef = process.env.INPUT_BASE_REF || "main";
    console.log(`🔍 Getting PR diff context against base ref: ${baseRef}`);
    const items = [];
    try {
        // Fetch the base branch
        console.log(`📥 Fetching origin/${baseRef}...`);
        (0, node_child_process_1.execSync)(`git fetch origin ${baseRef}`, { encoding: 'utf-8', stdio: 'pipe' });
        // Get list of changed files
        console.log(`📋 Getting list of changed files...`);
        const diffOutput = (0, node_child_process_1.execSync)(`git diff --name-only origin/${baseRef}...HEAD`, {
            encoding: 'utf-8',
            stdio: 'pipe'
        });
        const files = diffOutput.trim().split("\n").filter(file => file.trim());
        console.log(`📁 Found ${files.length} changed files`);
        if (files.length === 0) {
            console.log("ℹ️  No files changed in this PR");
            return items;
        }
        for (const file of files) {
            if (!file.trim())
                continue;
            // Check include/exclude patterns
            if (config.includeFiles.length > 0 && !(0, utils_1.doesAnyPatternMatch)(config.includeFiles, file)) {
                console.log(`⏭️  Excluding file (not in include patterns): ${file}`);
                continue;
            }
            if (config.excludeFiles.length > 0 && (0, utils_1.doesAnyPatternMatch)(config.excludeFiles, file)) {
                console.log(`⏭️  Excluding file (matches exclude patterns): ${file}`);
                continue;
            }
            try {
                console.log(`📄 Processing file: ${file}`);
                const fileDiffOutput = (0, node_child_process_1.execSync)(`git diff origin/${baseRef}...HEAD -- "${file}"`, {
                    encoding: 'utf-8',
                    stdio: 'pipe'
                });
                if (fileDiffOutput.trim()) {
                    items.push({
                        path: file,
                        context: fileDiffOutput
                    });
                    console.log(`✅ Added diff context for: ${file} (${fileDiffOutput.length} characters)`);
                }
                else {
                    console.log(`⚠️  No diff content found for: ${file}`);
                }
            }
            catch (error) {
                console.error(`❌ Error getting diff for file ${file}:`);
                console.error(`   Error: ${error instanceof Error ? error.message : String(error)}`);
                // Continue processing other files
            }
        }
    }
    catch (error) {
        console.error(`❌ Error in getPrDiffContext:`);
        console.error(`   Error: ${error instanceof Error ? error.message : String(error)}`);
        if (error && typeof error === 'object' && 'stdout' in error)
            console.error(`   Stdout: ${error.stdout}`);
        if (error && typeof error === 'object' && 'stderr' in error)
            console.error(`   Stderr: ${error.stderr}`);
        throw error;
    }
    console.log(`📊 Successfully processed ${items.length} files for review`);
    return items;
}
// Enhanced head diff context retrieval
async function getHeadDiffContext() {
    console.log(`🔍 Getting HEAD diff context...`);
    const items = [];
    try {
        const diffOutput = (0, node_child_process_1.execSync)(`git diff --name-only HEAD^`, {
            encoding: 'utf-8',
            stdio: 'pipe'
        });
        const files = diffOutput.trim().split("\n").filter(file => file.trim());
        console.log(`📁 Found ${files.length} changed files in HEAD`);
        for (const file of files) {
            if (!file.trim())
                continue;
            if (config.includeFiles.length > 0 && !(0, utils_1.doesAnyPatternMatch)(config.includeFiles, file)) {
                console.log(`⏭️  Excluding file (not in include patterns): ${file}`);
                continue;
            }
            if (config.excludeFiles.length > 0 && (0, utils_1.doesAnyPatternMatch)(config.excludeFiles, file)) {
                console.log(`⏭️  Excluding file (matches exclude patterns): ${file}`);
                continue;
            }
            try {
                const fileDiffOutput = (0, node_child_process_1.execSync)(`git diff HEAD^ -- "${file}"`, {
                    encoding: 'utf-8',
                    stdio: 'pipe'
                });
                if (fileDiffOutput.trim()) {
                    items.push({
                        path: file,
                        context: fileDiffOutput
                    });
                    console.log(`✅ Added diff context for: ${file}`);
                }
            }
            catch (error) {
                console.error(`❌ Error getting diff for file ${file}: ${error instanceof Error ? error.message : String(error)}`);
            }
        }
    }
    catch (error) {
        console.error(`❌ Error in getHeadDiffContext: ${error instanceof Error ? error.message : String(error)}`);
        throw error;
    }
    return items;
}
// Enhanced main function with comprehensive error handling
async function aiCheckDiffContext() {
    console.log(`🚀 Starting AI code review process...`);
    console.log(`   - Review mode: ${config.reviewPullRequest ? 'Pull Request' : 'HEAD commit'}`);
    try {
        const commitShaUrl = `${process.env.GITHUB_SERVER_URL || "https://github.com"}/${process.env.INPUT_REPOSITORY}/commit/${process.env.GITHUB_SHA}`;
        // Get diff context based on review mode
        const items = config.reviewPullRequest
            ? await getPrDiffContext()
            : await getHeadDiffContext();
        if (items.length === 0) {
            console.log("ℹ️  No files to review. Exiting successfully.");
            return;
        }
        console.log(`📝 Starting review of ${items.length} files...`);
        let successCount = 0;
        let errorCount = 0;
        for (let i = 0; i < items.length; i++) {
            const item = items[i];
            console.log(`\n📄 Processing file ${i + 1}/${items.length}: ${item.path}`);
            try {
                // Generate AI review
                const response = await aiGenerate({
                    host: url,
                    token: process.env.INPUT_AI_TOKEN,
                    prompt: item.context,
                    model: model,
                    system: process.env.INPUT_REVIEW_PROMPT
                });
                // Process AI response
                let commit = response.response;
                // Clean up markdown formatting if present
                if (commit.startsWith("```markdown")) {
                    commit = commit.substring("```markdown".length);
                    if (commit.endsWith("```")) {
                        commit = commit.substring(0, commit.length - 3);
                    }
                }
                // Create comment
                const reviewTitle = "🤖 AI Code Review";
                const fileUrl = `${commitShaUrl}/${item.path}`;
                const comments = `# ${reviewTitle}\n**File:** [${item.path}](${fileUrl})\n\n${commit.trim()}`;
                // Post comment
                const resp = await pushComments(comments);
                if (!resp?.id) {
                    throw new Error("Failed to post comment - no response ID received");
                }
                console.log(`✅ Successfully posted review comment for ${item.path} (ID: ${resp.id})`);
                successCount++;
            }
            catch (error) {
                console.error(`❌ Failed to process file ${item.path}:`);
                console.error(`   Error: ${error instanceof Error ? error.message : String(error)}`);
                errorCount++;
                // Continue processing other files instead of failing completely
            }
        }
        // Summary
        console.log(`\n📊 Review Summary:`);
        console.log(`   ✅ Successfully reviewed: ${successCount} files`);
        console.log(`   ❌ Failed to review: ${errorCount} files`);
        console.log(`   📁 Total files processed: ${items.length}`);
        if (errorCount > 0 && successCount === 0) {
            throw new Error(`All ${items.length} files failed to be reviewed`);
        }
    }
    catch (error) {
        console.error(`💥 Critical error in aiCheckDiffContext:`);
        console.error(`   Error: ${error instanceof Error ? error.message : String(error)}`);
        console.error(`   Stack: ${error instanceof Error ? error.stack : 'No stack trace available'}`);
        process.exit(1);
    }
}
// Main execution with graceful error handling
console.log("🎯 AI Code Review Bot Starting...");
aiCheckDiffContext()
    .then(() => {
    console.log("🎉 Code review process completed successfully!");
    process.exit(0);
})
    .catch((error) => {
    console.error("💥 Code review process failed:");
    console.error(`   Error: ${error instanceof Error ? error.message : String(error)}`);
    console.error(`   Stack: ${error instanceof Error ? error.stack : 'No stack trace available'}`);
    process.exit(1);
});
