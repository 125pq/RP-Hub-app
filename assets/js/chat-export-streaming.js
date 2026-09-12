(function (global) {
    'use strict';

    const countFloors = (messages) => {
        let count = 0;
        let previousRole = null;
        for (const message of messages) {
            if (!message || typeof message !== 'object') continue;
            const role = message.role;
            if (role === 'system') continue;
            const isMergeable = role === 'user' || role === 'assistant';
            if (previousRole === null || previousRole !== role || !isMergeable) count += 1;
            previousRole = role;
        }
        return count;
    };
    const countMessages = (messages) => {
        let count = 0;
        for (const message of messages) {
            if (message?.role === 'user' || message?.role === 'assistant') count += 1;
        }
        return count;
    };

    async function* stream(manifest, branchChats, cloneForStorage) {
        yield JSON.stringify(manifest);
        for (const branch of branchChats) {
            yield '\n{"branchId":' + JSON.stringify(branch.branchId) + ',"messages":[';
            const messages = branch.messages;
            for (let messageIndex = 0; messageIndex < messages.length; messageIndex += 1) {
                if (messageIndex > 0) yield ',';
                yield JSON.stringify(cloneForStorage(messages[messageIndex]));
            }
            yield ']}';
        }
    }

    global.RPHubChatExport = Object.freeze({ countFloors, countMessages, stream });
})(window);
