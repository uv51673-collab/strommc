// welcome.js

import { logger } from './logger.js';

const DEFAULT_TEMPLATES = {
    welcome: 'Welcome {user} to {server}!',
    goodbye: '{user.tag} has left the server.'
};

function replaceAll(message, token, value) {
    if (value === undefined || value === null) {
        return message;
    }
    return message.split(token).join(String(value));
}

export function truncateForEmbedField(value, maxLength = 1024) {
    const text = String(value ?? '').trim();
    if (!text) {
        return '—';
    }
    return text.length <= maxLength ? text : `${text.slice(0, maxLength - 1)}…`;
}

export function formatWelcomeMessage(message, data) {
    
    if (typeof message !== 'string') return '';
    if (!message) return '';
    if (!data || typeof data !== 'object') return message;

    const user = data?.user;
    const guild = data?.guild;

    if (!user || typeof user !== 'object') {
        logger.warn('Invalid user object passed to formatWelcomeMessage');
    }
    if (!guild || typeof guild !== 'object') {
        logger.warn('Invalid guild object passed to formatWelcomeMessage');
    }

    const tokens = {
        '{user}': user?.toString?.() || 'User',
        '{user.mention}': user?.toString?.() || 'User',
        '{user.tag}': user?.tag || 'Unknown#0000',
        '{user.username}': user?.username || 'Unknown',
        '{username}': user?.username || 'Unknown',
        '{user.discriminator}': user?.discriminator || '0000',
        '{user.id}': user?.id || 'unknown',
        '{server}': guild?.name || 'Server',
        '{server.name}': guild?.name || 'Server',
        '{guild.name}': guild?.name || 'Server',
        '{guild.id}': guild?.id || 'unknown',
        '{guild.memberCount}': guild?.memberCount?.toString?.() || '0',
        '{memberCount}': guild?.memberCount?.toString?.() || '0',
        '{membercount}': guild?.memberCount?.toString?.() || '0'
    };

    let result = message;
    for (const [token, value] of Object.entries(tokens)) {
        if (value === undefined || value === null) continue;
        result = replaceAll(result, token, String(value));
    }

    return result;
}

export function getDefaultWelcomeMessage() {
    return DEFAULT_TEMPLATES.welcome;
}

export function getDefaultGoodbyeMessage() {
    return DEFAULT_TEMPLATES.goodbye;
}

const DISCORD_CDN_HOSTS = new Set(['cdn.discordapp.com', 'media.discordapp.net']);

/**
 * Returns a usable image URL for an embed, or null if there is none.
 * Discord attachment links (e.g. images uploaded through the dashboard) are signed
 * and expire after ~24h, which makes the welcome/goodbye photo disappear. We ask
 * Discord for a freshly signed URL before sending. Any failure falls back to the
 * stored URL so the message is still sent.
 */
export async function resolveEmbedImageUrl(client, rawUrl) {
    if (typeof rawUrl !== 'string' || !rawUrl.trim()) return null;

    let url;
    try {
        url = new URL(rawUrl.trim());
        if (!['http:', 'https:'].includes(url.protocol)) return null;
    } catch {
        return null;
    }

    if (DISCORD_CDN_HOSTS.has(url.hostname) && url.pathname.startsWith('/attachments/')) {
        try {
            const res = await client.rest.post('/attachments/refresh-urls', {
                body: { attachment_urls: [url.toString()] },
            });
            const refreshed = res?.refreshed_urls?.[0]?.refreshed;
            if (refreshed) return refreshed;
        } catch (error) {
            logger.debug('Could not refresh Discord attachment URL:', error?.message || error);
        }
    }

    return url.toString();
}
