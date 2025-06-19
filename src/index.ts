import { execSync } from "node:child_process";
import { doesAnyPatternMatch, post, split_message, testConnection } from "./utils";
import { take_system_prompt } from "./prompt";

// Enhanced configuration with better timeout handling
const config = {
  useChinese: false,
  language: "English",
  promptGenre: process.env.INPUT_PROMPT_GENRE?.trim() || "",
  reviewersPrompt: process.env.INPUT_REVIEWERS_PROMPT?.trim() || "",
  includeFiles: split_message(process.env.INPUT_INCLUDE_FILES || ""),
  excludeFiles: split_message(process.env.INPUT_EXCLUDE_FILES || ""),
  reviewPullRequest: process.env.INPUT_REVIEW_PULL_REQUEST?.toLowerCase() === "true",
  maxRetries: 3,
  retryDelay: 5000, // Increased to 5 seconds
  timeout: 120000, // Increased to 2 minutes for AI calls
  connectionTimeout: 10000, // 10 seconds for connection tests
  maxPromptLength: 8000, // Limit prompt length to avoid overwhelming the model
};

const systemPrompt = config.reviewersPrompt || take_system_prompt(config.promptGenre, config.language);

// Validate required environment variables
function validateEnvironment(): { url: string; model: string } {
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
  } catch (error) {
    console.error(`❌ ERROR: Invalid URL format for HOST: ${url}`);
    console.error(`   Error: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
  
  console.log(`✅ Configuration validated:`);
  console.log(`   - Host: ${url}`);
  console.log(`   - Model: ${model}`);
  console.log(`   - Review Pull Request: ${config.reviewPullRequest}`);
  console.log(`   - AI Timeout: ${config.timeout}ms`);
  console.log(`   - Max Prompt Length: ${config.maxPromptLength} chars`);
  
  return { url, model };
}

const { url, model } = validateEnvironment();

// Test Ollama connectivity before proceeding
async function testOllamaConnection(): Promise<void> {
  console.log("🔌 Testing Ollama connectivity...");
  
  try {
    const result = await testConnection(url);
    
    if (result.success) {
      console.log(`✅ Ollama connection successful (${result.responseTime}ms)`);
    } else {
      console.error(`❌ Ollama connection failed: ${result.message}`);
      console.error("   Please check:");
      console.error("   1. Is Ollama running and accessible?");
      console.error("   2. Is the HOST URL correct?");
      console.error("   3. Are there any network/firewall issues?");
      throw new Error(`Ollama connectivity test failed: ${result.message}`);
    }
  } catch (error) {
    console.error("❌ Failed to test Ollama connectivity");
    throw error;
  }
}

// Utility function for retrying operations with exponential backoff
async function withRetry<T>(
  operation: () => Promise<T>,
  operationName: string,
  maxRetries: number = config.maxRetries,
  useExponentialBackoff: boolean = false
): Promise<T> {
  let lastError: Error;
  
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      console.log(`🔄 Attempting ${operationName} (attempt ${attempt}/${maxRetries})`);
      return await operation();
    } catch (error) {
      lastError = error as Error;
      console.error(`❌ Attempt ${attempt} failed for ${operationName}:`);
      console.error(`   Error: ${lastError.message}`);
      
      // Check for specific errors that might indicate service issues
      const errorMessage = lastError.message.toLowerCase();
      if (errorMessage.includes('socket hang up') || 
          errorMessage.includes('econnreset') || 
          errorMessage.includes('timeout')) {
        console.error("   ⚠️  This appears to be a connectivity/timeout issue");
      }
      
      if (attempt < maxRetries) {
        const delay = useExponentialBackoff 
          ? config.retryDelay * Math.pow(2, attempt - 1)
          : config.retryDelay;
        
        console.log(`⏳ Waiting ${delay}ms before retry...`);
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
  }
  
  console.error(`💥 All ${maxRetries} attempts failed for ${operationName}`);
  throw lastError!;
}

// Enhanced comment posting with better error handling
async function pushComments(message: string): Promise<any> {
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
  const endpoint = `${apiUrl}/repos/${repository}/issues/${pullRequestNumber}/comments`;
  
  console.log(`📤 Posting comment to PR #${pullRequestNumber} in ${repository}`);
  console.log('API Details:');
  console.log('- Endpoint:', endpoint);
  console.log('- Is Gitea:', isGitea);
  console.log('- Has Token:', !!token);
  
  return await withRetry(async () => {
    return await post({
      url: endpoint,
      body: { body: message },
      header: { 
        'Authorization': `token ${token}`,
        'Accept': 'application/vnd.github.v3+json',
        'User-Agent': 'AI-Review-Bot'
      },
      timeout: 15000 // Shorter timeout for GitHub API
    });
  }, "push comment");
}

// Function to truncate prompt if it's too long
function truncatePrompt(prompt: string, maxLength: number = config.maxPromptLength): string {
  if (prompt.length <= maxLength) {
    return prompt;
  }
  
  console.log(`⚠️  Prompt too long (${prompt.length} chars), truncating to ${maxLength} chars`);
  
  // Try to truncate intelligently by keeping the header and footer
  const lines = prompt.split('\n');
  if (lines.length > 10) {
    // Keep first 5 and last 5 lines, truncate middle
    const header = lines.slice(0, 5).join('\n');
    const footer = lines.slice(-5).join('\n');
    const truncated = `${header}\n\n[... content truncated for length ...]\n\n${footer}`;
    
    if (truncated.length <= maxLength) {
      return truncated;
    }
  }
  
  // Simple truncation with ellipsis
  return prompt.substring(0, maxLength - 50) + '\n\n[... truncated for length ...]';
}

// Enhanced AI generation with better error handling and timeout management
async function aiGenerate({ host, token, prompt, model, system }: any): Promise<any> {
  if (!prompt?.trim()) {
    throw new Error("Empty or invalid prompt provided to AI generation");
  }
  
  // Truncate prompt if too long
  const truncatedPrompt = truncatePrompt(prompt.trim());
  
  const requestData = {
    prompt: truncatedPrompt,
    model: model,
    stream: false,
    system: system || systemPrompt,
    options: {
      tfs_z: 1.5,
      top_k: 30,
      top_p: 0.8,
      temperature: 0.7,
      num_ctx: 8192, // Reduced context size for better performance
      num_predict: 2048, // Limit response length
    }
  };
  
  console.log(`🤖 Generating AI review:`);
  console.log(`   - Model: ${model}`);
  console.log(`   - Host: ${host}`);
  console.log(`   - Prompt length: ${truncatedPrompt.length} chars`);
  console.log(`   - Timeout: ${config.timeout}ms`);
  
  return await withRetry(async () => {
    const response = await post({
      url: `${host}/api/generate`,
      body: requestData,
      header: {
        'Authorization': token ? `Bearer ${token}` : "",
        'Content-Type': 'application/json'
      },
      timeout: config.timeout // Use longer timeout for AI calls
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
    
    console.log(`✅ AI response received (${response.response.length} chars)`);
    return response;
  }, "AI generation", 2, true); // Use exponential backoff for AI calls
}

// Enhanced diff context retrieval with better error handling
async function getPrDiffContext(): Promise<Array<{ path: string; context: string }>> {
  const baseRef = process.env.INPUT_BASE_REF || "main";
  console.log(`🔍 Getting PR diff context against base ref: ${baseRef}`);
  
  const items: Array<{ path: string; context: string }> = [];
  
  try {
    // Fetch the base branch
    console.log(`📥 Fetching origin/${baseRef}...`);
    execSync(`git fetch origin ${baseRef}`, { encoding: 'utf-8', stdio: 'pipe' });
    
    // Get list of changed files
    console.log(`📋 Getting list of changed files...`);
    const diffOutput = execSync(`git diff --name-only origin/${baseRef}...HEAD`, { 
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
      if (!file.trim()) continue;
      
      // Check include/exclude patterns
      if (config.includeFiles.length > 0 && !doesAnyPatternMatch(config.includeFiles, file)) {
        console.log(`⏭️  Excluding file (not in include patterns): ${file}`);
        continue;
      }
      
      if (config.excludeFiles.length > 0 && doesAnyPatternMatch(config.excludeFiles, file)) {
        console.log(`⏭️  Excluding file (matches exclude patterns): ${file}`);
        continue;
      }
      
      try {
        console.log(`📄 Processing file: ${file}`);
        const fileDiffOutput = execSync(`git diff origin/${baseRef}...HEAD -- "${file}"`, {
          encoding: 'utf-8',
          stdio: 'pipe'
        });
        
        if (fileDiffOutput.trim()) {
          // Limit diff size to prevent overwhelming the AI
          const limitedDiff = fileDiffOutput.length > 10000 
            ? fileDiffOutput.substring(0, 10000) + '\n... [diff truncated for length]'
            : fileDiffOutput;
            
          items.push({
            path: file,
            context: limitedDiff
          });
          console.log(`✅ Added diff context for: ${file} (${limitedDiff.length} characters)`);
        } else {
          console.log(`⚠️  No diff content found for: ${file}`);
        }
      } catch (error) {
        console.error(`❌ Error getting diff for file ${file}:`);
        console.error(`   Error: ${error instanceof Error ? error.message : String(error)}`);
        // Continue processing other files
      }
    }
  } catch (error) {
    console.error(`❌ Error in getPrDiffContext:`);
    console.error(`   Error: ${error instanceof Error ? error.message : String(error)}`);
    if (error && typeof error === 'object' && 'stdout' in error) console.error(`   Stdout: ${error.stdout}`);
    if (error && typeof error === 'object' && 'stderr' in error) console.error(`   Stderr: ${error.stderr}`);
    throw error;
  }
  
  console.log(`📊 Successfully processed ${items.length} files for review`);
  return items;
}

// Enhanced head diff context retrieval
async function getHeadDiffContext(): Promise<Array<{ path: string; context: string }>> {
  console.log(`🔍 Getting HEAD diff context...`);
  
  const items: Array<{ path: string; context: string }> = [];
  
  try {
    const diffOutput = execSync(`git diff --name-only HEAD^`, {
      encoding: 'utf-8',
      stdio: 'pipe'
    });
    
    const files = diffOutput.trim().split("\n").filter(file => file.trim());
    console.log(`📁 Found ${files.length} changed files in HEAD`);
    
    for (const file of files) {
      if (!file.trim()) continue;
      
      if (config.includeFiles.length > 0 && !doesAnyPatternMatch(config.includeFiles, file)) {
        console.log(`⏭️  Excluding file (not in include patterns): ${file}`);
        continue;
      }
      
      if (config.excludeFiles.length > 0 && doesAnyPatternMatch(config.excludeFiles, file)) {
        console.log(`⏭️  Excluding file (matches exclude patterns): ${file}`);
        continue;
      }
      
      try {
        const fileDiffOutput = execSync(`git diff HEAD^ -- "${file}"`, {
          encoding: 'utf-8',
          stdio: 'pipe'
        });
        
        if (fileDiffOutput.trim()) {
          // Limit diff size
          const limitedDiff = fileDiffOutput.length > 10000 
            ? fileDiffOutput.substring(0, 10000) + '\n... [diff truncated for length]'
            : fileDiffOutput;
            
          items.push({
            path: file,
            context: limitedDiff
          });
          console.log(`✅ Added diff context for: ${file}`);
        }
      } catch (error) {
        console.error(`❌ Error getting diff for file ${file}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  } catch (error) {
    console.error(`❌ Error in getHeadDiffContext: ${error instanceof Error ? error.message : String(error)}`);
    throw error;
  }
  
  return items;
}

// Enhanced main function with comprehensive error handling and better resilience
async function aiCheckDiffContext(): Promise<void> {
  console.log(`🚀 Starting AI code review process...`);
  console.log(`   - Review mode: ${config.reviewPullRequest ? 'Pull Request' : 'HEAD commit'}`);
  
  try {
    // Test Ollama connectivity first
    await testOllamaConnection();
    
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
    const failedFiles: string[] = [];
    
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      console.log(`\n📄 Processing file ${i + 1}/${items.length}: ${item.path}`);
      
      try {
        // Add a small delay between requests to avoid overwhelming the server
        if (i > 0) {
          console.log("⏳ Waiting 2s before next request...");
          await new Promise(resolve => setTimeout(resolve, 2000));
        }
        
        // Generate AI review
        const response = await aiGenerate({
          host: url,
          token: process.env.INPUT_AI_TOKEN,
          prompt: item.context,
          model: model,
          system: process.env.INPUT_REVIEW_PROMPT
        });
        
        // Process AI response
        let commit: string = response.response;
        
        // Clean up markdown formatting if present
        if (commit.startsWith("```markdown")) {
          commit = commit.substring("```markdown".length);
          if (commit.endsWith("```")) {
            commit = commit.substring(0, commit.length - 3);
          }
        }
        
        // Create comment with additional context
        const reviewTitle = "🤖 AI Code Review";
        const fileUrl = `${commitShaUrl}/${item.path}`;
        const timestamp = new Date().toISOString();
        const comments = `# ${reviewTitle}
**File:** [${item.path}](${fileUrl})
**Model:** ${model}
**Reviewed at:** ${timestamp}

${commit.trim()}

---
*This review was generated automatically by AI. Please review the suggestions carefully before implementing.*`;
        
        // Post comment
        const resp = await pushComments(comments);
        
        if (!resp?.id) {
          throw new Error("Failed to post comment - no response ID received");
        }
        
        console.log(`✅ Successfully posted review comment for ${item.path} (ID: ${resp.id})`);
        successCount++;
        
      } catch (error) {
        console.error(`❌ Failed to process file ${item.path}:`);
        console.error(`   Error: ${error instanceof Error ? error.message : String(error)}`);
        errorCount++;
        failedFiles.push(item.path);
        
        // Continue processing other files instead of failing completely
      }
    }
    
    // Summary
    console.log(`\n📊 Review Summary:`);
    console.log(`   ✅ Successfully reviewed: ${successCount} files`);
    console.log(`   ❌ Failed to review: ${errorCount} files`);
    console.log(`   📁 Total files processed: ${items.length}`);
    
    if (failedFiles.length > 0) {
      console.log(`   Failed files: ${failedFiles.join(', ')}`);
    }
    
    // Only fail if all files failed to be reviewed
    if (errorCount > 0 && successCount === 0) {
      throw new Error(`All ${items.length} files failed to be reviewed. Please check Ollama connectivity and configuration.`);
    }
    
    if (errorCount > 0 && successCount > 0) {
      console.log(`⚠️  Partial success: ${successCount} files reviewed, ${errorCount} files failed`);
    }
    
  } catch (error) {
    console.error(`💥 Critical error in aiCheckDiffContext:`);
    console.error(`   Error: ${error instanceof Error ? error.message : String(error)}`);
    console.error(`   Stack: ${error instanceof Error ? error.stack : 'No stack trace available'}`);
    
    // Provide helpful debugging information
    console.error(`\n🔧 Debugging Information:`);
    console.error(`   - Ollama Host: ${url}`);
    console.error(`   - Model: ${model}`);
    console.error(`   - Timeout: ${config.timeout}ms`);
    console.error(`   - Max Retries: ${config.maxRetries}`);
    
    process.exit(1);
  }
}

// Main execution with graceful error handling
console.log("🎯 AI Code Review Bot Starting...");
console.log(`⚙️  Configuration: timeout=${config.timeout}ms, retries=${config.maxRetries}, delay=${config.retryDelay}ms`);

aiCheckDiffContext()
  .then(() => {
    console.log("🎉 Code review process completed successfully!");
    process.exit(0);
  })
  .catch((error) => {
    console.error("💥 Code review process failed:");
    console.error(`   Error: ${error instanceof Error ? error.message : String(error)}`);
    console.error(`   Stack: ${error instanceof Error ? error.stack : 'No stack trace available'}`);
    
    // Exit with appropriate codes
    if (error.message.includes('connectivity') || error.message.includes('timeout')) {
      console.error("\n🔧 Suggested fixes:");
      console.error("   1. Check if Ollama is running and accessible");
      console.error("   2. Verify network connectivity");
      console.error("   3. Consider increasing timeout values");
      console.error("   4. Check if the model is loaded in Ollama");
      process.exit(2); // Network/connectivity issue
    } else {
      process.exit(1); // General error
    }
  });
