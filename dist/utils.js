"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.testConnection = exports.post = exports.doesAnyPatternMatch = exports.split_message = void 0;
const http_1 = __importDefault(require("http"));
const https_1 = __importDefault(require("https"));
/**
 * Split a string by newlines or commas and return clean non-empty strings
 * @param files - Input string to split
 * @returns Array of trimmed, non-empty strings
 */
function split_message(files) {
    if (!files || typeof files !== 'string') {
        return [];
    }
    const trimmedFiles = files.trim();
    if (!trimmedFiles) {
        return [];
    }
    let result = [];
    // Check if the string contains newlines
    const hasNewlines = trimmedFiles.includes('\n') || trimmedFiles.includes('\r');
    if (hasNewlines) {
        result = trimmedFiles.split(/[\r\n]+/);
    }
    else {
        result = trimmedFiles.split(',');
    }
    // Clean up the results: trim whitespace and filter out empty strings
    return result
        .map(str => str.trim())
        .filter(item => item.length > 0);
}
exports.split_message = split_message;
/**
 * Check if any pattern in the array matches the given string
 * @param patterns - Array of regex patterns to test
 * @param str - String to test against patterns
 * @returns True if any pattern matches, false otherwise
 */
function doesAnyPatternMatch(patterns, str) {
    if (!Array.isArray(patterns) || patterns.length === 0) {
        return false;
    }
    if (!str || typeof str !== 'string') {
        return false;
    }
    return patterns.some(pattern => {
        try {
            // Create regex with proper error handling
            const regex = new RegExp(pattern);
            return regex.test(str);
        }
        catch (error) {
            console.error(`❌ Invalid regex pattern: ${pattern}`);
            console.error(`   Error: ${error instanceof Error ? error.message : String(error)}`);
            return false;
        }
    });
}
exports.doesAnyPatternMatch = doesAnyPatternMatch;
/**
 * Enhanced HTTP/HTTPS POST request with robust error handling
 * @param options - Request configuration
 * @returns Promise resolving to parsed response
 */
async function post({ url, body, header = {}, json = true, timeout = 30000 }) {
    return new Promise((resolve, reject) => {
        // Validate inputs
        if (!url || typeof url !== 'string') {
            reject(new Error('URL is required and must be a string'));
            return;
        }
        let parsedUrl;
        try {
            parsedUrl = new URL(url);
        }
        catch (error) {
            reject(new Error(`Invalid URL format: ${url}. Error: ${error instanceof Error ? error.message : String(error)}`));
            return;
        }
        // Prepare request data
        const requestData = typeof body === "string" ? body : JSON.stringify(body);
        // Setup headers with defaults
        const headers = {
            'Content-Type': 'application/json',
            'User-Agent': 'AI-Review-Bot/1.0',
            ...header,
            'Content-Length': Buffer.byteLength(requestData).toString()
        };
        // Request options with SSL bypass for HTTPS
        const requestOptions = {
            hostname: parsedUrl.hostname,
            port: parsedUrl.port || (parsedUrl.protocol === 'https:' ? 443 : 80),
            path: parsedUrl.pathname + (parsedUrl.search || ''),
            method: 'POST',
            headers: headers,
            timeout: timeout
        };
        // For HTTPS requests, disable SSL verification to handle proxy certificates
        if (parsedUrl.protocol === 'https:') {
            requestOptions.rejectUnauthorized = false;
            requestOptions.requestCert = false;
            requestOptions.agent = false;
        }
        console.log(`🌐 Making ${parsedUrl.protocol.toUpperCase()} request to: ${parsedUrl.hostname}:${requestOptions.port}`);
        console.log(`   Path: ${requestOptions.path}`);
        console.log(`   Content-Length: ${headers['Content-Length']} bytes`);
        // Create request
        const client = parsedUrl.protocol === 'http:' ? http_1.default : https_1.default;
        const req = client.request(requestOptions, (res) => {
            let responseBody = '';
            let charset = 'utf-8';
            // Handle response status codes
            const statusCode = res.statusCode || 0;
            console.log(`📡 Response status: ${statusCode} ${res.statusMessage || ''}`);
            if (statusCode < 200 || statusCode >= 300) {
                console.error(`❌ HTTP Error: ${statusCode} ${res.statusMessage}`);
                console.error(`   Response headers:`, res.headers);
            }
            // Parse content-type for encoding
            const contentType = res.headers['content-type'];
            if (contentType) {
                const charsetMatch = contentType.match(/charset=([\w-]+)/i);
                if (charsetMatch) {
                    const detectedCharset = charsetMatch[1].toLowerCase();
                    switch (detectedCharset) {
                        case 'utf-8':
                            charset = 'utf-8';
                            break;
                        case 'ascii':
                            charset = 'ascii';
                            break;
                        case 'gbk':
                            // GBK is not directly supported, fallback to ascii
                            charset = 'ascii';
                            break;
                        default:
                            charset = 'utf-8';
                    }
                }
            }
            res.setEncoding(charset);
            // Collect response data
            res.on('data', (chunk) => {
                responseBody += chunk;
            });
            // Handle response completion
            res.on('end', () => {
                console.log(`📥 Response received: ${responseBody.length} characters`);
                try {
                    if (json) {
                        // Attempt to parse JSON
                        if (!responseBody.trim()) {
                            reject(new Error('Empty response body when JSON was expected'));
                            return;
                        }
                        const parsedResponse = JSON.parse(responseBody);
                        // Handle HTTP error status codes even with valid JSON
                        if (statusCode < 200 || statusCode >= 300) {
                            reject(new Error(`HTTP ${statusCode}: ${res.statusMessage}. Response: ${JSON.stringify(parsedResponse)}`));
                            return;
                        }
                        resolve(parsedResponse);
                    }
                    else {
                        // Return raw text
                        if (statusCode < 200 || statusCode >= 300) {
                            reject(new Error(`HTTP ${statusCode}: ${res.statusMessage}. Response: ${responseBody}`));
                            return;
                        }
                        resolve(responseBody);
                    }
                }
                catch (parseError) {
                    console.error(`❌ Failed to parse response as ${json ? 'JSON' : 'text'}`);
                    console.error(`   Parse error: ${parseError instanceof Error ? parseError.message : String(parseError)}`);
                    console.error(`   Response body: ${responseBody.substring(0, 500)}${responseBody.length > 500 ? '...' : ''}`);
                    reject(new Error(`Failed to parse response: ${parseError instanceof Error ? parseError.message : String(parseError)}. Response: ${responseBody.substring(0, 200)}`));
                }
            });
        });
        // Handle request errors
        req.on('error', (error) => {
            console.error(`❌ Request error: ${error.message}`);
            console.error(`   Error code: ${error.code || 'Unknown'}`);
            console.error(`   URL: ${url}`);
            // Provide more specific error messages
            let errorMessage = `Request failed: ${error.message}`;
            const errorCode = error.code;
            if (errorCode === 'ENOTFOUND') {
                errorMessage = `DNS lookup failed for hostname: ${parsedUrl.hostname}. Please check the URL.`;
            }
            else if (errorCode === 'ECONNREFUSED') {
                errorMessage = `Connection refused to ${parsedUrl.hostname}:${requestOptions.port}. Please check if the service is running.`;
            }
            else if (errorCode === 'ETIMEDOUT') {
                errorMessage = `Request timed out after ${timeout}ms. The service may be slow or unresponsive.`;
            }
            else if (errorCode === 'CERT_HAS_EXPIRED') {
                errorMessage = `SSL certificate has expired for ${parsedUrl.hostname}.`;
            }
            else if (errorCode === 'UNABLE_TO_VERIFY_LEAF_SIGNATURE') {
                errorMessage = `SSL certificate verification failed for ${parsedUrl.hostname}. This may be due to a self-signed or invalid certificate.`;
            }
            reject(new Error(errorMessage));
        });
        // Handle request timeout
        req.on('timeout', () => {
            console.error(`⏱️  Request timeout after ${timeout}ms`);
            req.destroy();
            reject(new Error(`Request timeout after ${timeout}ms. The service may be slow or unresponsive.`));
        });
        // Send request data
        try {
            req.write(requestData);
            req.end();
        }
        catch (writeError) {
            console.error(`❌ Error writing request data: ${writeError instanceof Error ? writeError.message : String(writeError)}`);
            reject(new Error(`Failed to send request data: ${writeError instanceof Error ? writeError.message : String(writeError)}`));
        }
    });
}
exports.post = post;
/**
 * Helper function to test connectivity to an endpoint
 * @param url - URL to test
 * @returns Promise resolving to connection test result
 */
async function testConnection(url) {
    const startTime = Date.now();
    try {
        await post({
            url: `${url}/api/tags`,
            body: {},
            timeout: 10000
        });
        const responseTime = Date.now() - startTime;
        return {
            success: true,
            message: `Connection successful`,
            responseTime
        };
    }
    catch (error) {
        return {
            success: false,
            message: `Connection failed: ${error instanceof Error ? error.message : String(error)}`
        };
    }
}
exports.testConnection = testConnection;
