/**
 * Theme Redefine-X
 * analytics.js
 * Track Hexo execution results and send analytics
 */

const {
    version
} = require("../../package.json");
const os = require('os');

/**
 * Get detailed OS information
 * @returns {string} - Detailed OS info like "Windows 11 26200.7462"
 */
function getOSInfo() {
    const platform = os.platform();
    const release = os.release();
    const type = os.type();

    if (platform === 'win32') {
        // Windows: Try to get version name
        const version = release;
        return `Windows ${version}`;
    } else if (platform === 'darwin') {
        return `macOS ${release}`;
    } else if (platform === 'linux') {
        return `Linux ${release}`;
    } else {
        return `${type} ${release}`;
    }
}

/**
 * Extract relevant configuration based on error context
 * @param {Error} err - The error object
 * @param {Object} hexo - Hexo instance
 * @returns {Object} - Filtered relevant configuration
 */
function extractRelevantConfig(err, hexo) {
    const config = hexo.config || {};
    const themeConfig = hexo.theme.config || {};
    const errorMessage = (err.message || '') + (err.stack || '');

    // Always include basic info
    const relevantConfig = {
        // Basic Hexo config
        title: config.title,
        url: config.url,
        root: config.root,
        theme: config.theme,
        per_page: config.per_page,

        // Theme basic config
        theme_info: {
            title: themeConfig.info?.title,
            author: themeConfig.info?.author,
        }
    };

    // Analyze error message to determine relevant config sections
    const errorLower = errorMessage.toLowerCase();

    // CDN related errors
    if (errorLower.includes('cdn') || errorLower.includes('jsdelivr') || errorLower.includes('unpkg')) {
        relevantConfig.theme_cdn = themeConfig.cdn;
    }

    // Plugin related errors
    if (errorLower.includes('plugin') || errorLower.includes('feed') || errorLower.includes('sitemap') || errorLower.includes('search')) {
        relevantConfig.plugins = config.plugins || themeConfig.plugins;
    }

    // Comment system errors
    if (errorLower.includes('comment') || errorLower.includes('waline') || errorLower.includes('gitalk') || errorLower.includes('twikoo') || errorLower.includes('giscus')) {
        relevantConfig.theme_comment = themeConfig.comment;
    }

    // Rendering/generation errors
    if (errorLower.includes('render') || errorLower.includes('markdown') || errorLower.includes('post') || errorLower.includes('page')) {
        relevantConfig.markdown = config.markdown;
        relevantConfig.highlight = config.highlight;
        relevantConfig.prismjs = config.prismjs;
        relevantConfig.theme_articles = themeConfig.articles;
    }

    // Deployment errors
    if (errorLower.includes('deploy') || errorLower.includes('git')) {
        relevantConfig.deploy = config.deploy;
    }

    // Asset/image errors
    if (errorLower.includes('image') || errorLower.includes('asset') || errorLower.includes('lazyload')) {
        relevantConfig.theme_lazyload = themeConfig.articles?.lazyload;
        relevantConfig.post_asset_folder = config.post_asset_folder;
    }

    // Font errors
    if (errorLower.includes('font')) {
        relevantConfig.theme_fonts = themeConfig.global?.fonts;
    }

    // Analytics errors
    if (errorLower.includes('analytics') || errorLower.includes('google')) {
        relevantConfig.theme_analytics = themeConfig.global?.google_analytics;
    }

    return relevantConfig;
}

/**
 * Generate GitHub issue URL with pre-filled content
 * @param {Error} err - The error object
 * @param {Object} hexo - Hexo instance
 * @param {string} command - User command
 * @param {number} executionSeconds - Execution time in seconds
 * @returns {string} - GitHub issue URL
 */
function generateGitHubIssueUrl(err, hexo, command, executionSeconds) {
    const title = `[BUG] ${err.message || 'Error during Hexo execution'}`;

    // Determine priority based on error type
    let priority = 'Medium';
    let priorityLabel = 'Middle Priority';
    if (err.message && err.message.includes('FATAL')) {
        priority = 'High';
        priorityLabel = 'High Priority';
    } else if (err.message && (err.message.includes('warn') || err.message.includes('deprecated'))) {
        priority = 'Low';
        priorityLabel = 'Low Priority';
    }

    const body = `### Quick Checklist
- [x] I've tried running \`hexo clean\` but the issue is still there
- [ ] I'm using the latest version of the theme
- [ ] I've updated my theme configuration after updating

### What's the issue?
An error occurred while running Hexo.

**Command:** \`hexo ${command}\`
**Hexo Version:** ${hexo.version}
**Theme Version:** ${version}
**Running Time:** ${timeToRange(executionSeconds)}

### Error Message
\`\`\`
${err.message || String(err)}
\`\`\`

### Error Stack
\`\`\`
${err.stack || 'N/A'}
\`\`\`

### Relevant Configuration
<details>
<summary>Click to expand relevant config (auto-extracted)</summary>

\`\`\`json
${JSON.stringify(extractRelevantConfig(err, hexo), null, 2)}
\`\`\`

**Note:** Only configuration sections relevant to this error are shown above. This helps keep the issue report concise and focused.
</details>

### How can we reproduce this?
1. Run \`hexo ${command}\`
2. Error occurs

### What should have happened?
The command should execute without errors.

### Browser (if applicable)
- Browser: N/A (CLI error)

### Operating System
- OS: ${getOSInfo()}
- Node Version: ${process.version}
- Platform: ${process.platform} ${process.arch}

### Priority
${priority}`;

    const url = new URL('https://github.com/Jason-JP-Yang/hexo-theme-Redefine-X/issues/new');
    url.searchParams.set('title', title);
    url.searchParams.set('body', body);
    url.searchParams.set('labels', `bug,hexo cmd error,${priorityLabel}`);
    url.searchParams.set('assignees', 'Jason-JP-Yang');

    return url.toString();
}

/**
 * Convert exact count to range string
 * @param {number} count - exact count
 * @returns {string} - range string like "1-10", "11-50", ">500"
 */
function countToRange(count) {
    if (count === 0) return '0';
    if (count <= 10) return '1-10';
    if (count <= 20) return '11-20';
    if (count <= 30) return '21-30';
    if (count <= 40) return '31-40';
    if (count <= 50) return '41-50';
    if (count <= 100) return '51-100';
    if (count <= 200) return '101-200';
    if (count <= 500) return '201-500';
    return '>500';
}

/**
 * Convert execution time (in seconds) to range string
 * @param {number} seconds - execution time in seconds
 * @returns {string} - time range string like "<1s", "1-10s", ">20min"
 */
function timeToRange(seconds) {
    if (seconds < 1) return '<1s';
    if (seconds <= 10) return '1-10s';
    if (seconds <= 30) return '11-30s';
    if (seconds <= 60) return '31s-1min';
    if (seconds <= 300) return '1-5min';
    if (seconds <= 1200) return '5-20min';
    return '>20min';
}

hexo.on("ready", function () {
    // Initialize analytics data collection
    hexo._redefineAnalytics = {
        startTime: Date.now(),
        command: process.argv[2] || 'unknown',
        stats: {},
        errors: []
    };
});

hexo.on("generateAfter", function () {
    // Collect generation statistics
    if (hexo._redefineAnalytics) {
        const locals = hexo.locals.toObject();

        hexo._redefineAnalytics.stats = {
            posts: locals.posts ? locals.posts.length : 0,
            pages: locals.pages ? locals.pages.length : 0,
            categories: locals.categories ? locals.categories.length : 0,
            tags: locals.tags ? locals.tags.length : 0,
        };
    }
});

hexo.on("exit", async function (err) {
    // Wait until welcome event is finished to avoid conflicts
    while (!hexo._welcomeFinished) {
        await new Promise(resolve => setTimeout(resolve, 100));
    }

    // Check if analytics is enabled
    const analyticsEnabled = hexo.theme.config?.developer?.analytics?.enable;
    if (analyticsEnabled === false) {
        return;
    }

    // Check if umami was initialized
    if (!hexo._umamiInstance) {
        return;
    }

    const command = process.argv[2] || 'unknown';
    const analyticsData = hexo._redefineAnalytics || {};

    // Determine event name based on command
    let eventName = 'Hexo Other Command';
    switch (command) {
        case 'generate':
        case 'g':
            eventName = 'Hexo Generate Site';
            break;
        case 'server':
        case 's':
            eventName = 'Hexo Run Server';
            break;
        case 'deploy':
        case 'd':
            eventName = 'Hexo Deploy Site';
            break;
        case 'clean':
            eventName = 'Hexo Clean Cache';
            break;
    }

    // Prepare data payload
    // Extract user command (skip node executable and script paths)
    const userCommand = process.argv.slice(2).join(' ') || 'unknown';
    const executionSeconds = analyticsData.startTime ? (Date.now() - analyticsData.startTime) / 1000 : 0;

    const payload = {
        status: !err, // true if successful, false if error occurred
        'full-command': `hexo ${userCommand}`,
        'hexo-version': hexo.version,
        'theme-version': version,
        'running-time': timeToRange(executionSeconds)
    };

    // Add stats or error info based on status 
    if (!err && analyticsData.stats) {
        // Success: add statistics in ranges
        Object.assign(payload, {
            'total-posts': countToRange(analyticsData.stats.posts || 0),
            'total-pages': countToRange(analyticsData.stats.pages || 0),
            'total-categories': countToRange(analyticsData.stats.categories || 0),
            'total-tags': countToRange(analyticsData.stats.tags || 0),
        });
    } else if (err) {
        // Error: add error information (limited to avoid data size issues)
        payload['error-message'] = err.message || String(err);

        // Check auto_issue configuration, default to'ask' if not set
        const autoIssue = hexo.theme.config?.developer?.analytics?.auto_issue || 'ask';
        if (autoIssue === true || autoIssue === 'ask') {
            const issueUrl = generateGitHubIssueUrl(err, hexo, userCommand, executionSeconds);

            if (autoIssue === 'ask') {
                // Interactive mode: wait for user input
                const readline = require('readline');
                const rl = readline.createInterface({
                    input: process.stdin,
                    output: process.stdout
                });
                
                hexo.log.error('An error occurred during Hexo execution.');
                return new Promise((resolve) => {
                    rl.question('Would you like to open a GitHub issue to report this? (y/n): ', (answer) => {
                        rl.close();
                        if (answer.toLowerCase() === 'y' || answer.toLowerCase() === 'yes') {
                            hexo.log.info('Opening GitHub issue page...');
                            const OPEN = require('open');
                            OPEN.default(issueUrl);
                        } else {
                            hexo.log.info('Issue report skipped.');
                        }
                        resolve();
                    });
                }).then(() => {
                    // Send analytics after user response
                    return sendAnalytics();
                });
            } else if (autoIssue === true) {
                hexo.log.info('Opening GitHub issue page automatically...');
                const OPEN = require('open');
                OPEN.default(issueUrl);
            }
        }
    }

    // Send analytics function
    async function sendAnalytics() {
        try {
            await hexo._umamiInstance.track({ tag: `v${version}`, name: eventName, data: payload });
            hexo.log.debug(`Analytics sent: ${eventName}`);
        } catch (error) {
            hexo.log.warn(`Failed to send analytics: ${error.message}`);
        }
    }

    // If not in ask mode or no error, send analytics immediately
    const autoIssue = hexo.theme.config?.developer?.analytics?.auto_issue;

    if (!err || autoIssue !== 'ask') {
        await sendAnalytics();
    }
});