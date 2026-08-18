export const getApiUrl = () => {
  if (process.env.NEXT_PUBLIC_API_URL) return process.env.NEXT_PUBLIC_API_URL.replace(/\/+$/, '');
  // No hardcoded production host fallback: a deployment that forgets to set
  // NEXT_PUBLIC_API_URL should fail visibly against localhost rather than silently
  // sending its customers' data to someone else's demo API.
  if (typeof window !== 'undefined' && !['localhost', '127.0.0.1'].includes(window.location.hostname)) {
    console.error(
      '[ACE] NEXT_PUBLIC_API_URL is not set. API requests will fail. ' +
      'Set it to your API origin at build time.'
    );
  }
  return 'http://localhost:4000';
};

export const API_URL = getApiUrl();

const getHeaders = () => {
  const token = typeof window !== "undefined" ? localStorage.getItem("ace_token") : null;
  return {
    "Content-Type": "application/json",
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
};

export const clearSession = () => {
  if (typeof window === "undefined") return;
  localStorage.removeItem("ace_token");
  localStorage.removeItem("ace_refresh_token");
  localStorage.removeItem("ace_user");
};

/**
 * Exchanges the stored refresh token for a fresh access token.
 *
 * The login response has always included a 7-day refreshToken and the API has always
 * exposed /api/auth/refresh, but the dashboard stored neither and called neither —
 * so every session hard-expired after the access token's lifetime and dumped the
 * user at the login screen mid-task. Concurrent 401s share one in-flight refresh.
 */
let refreshInFlight: Promise<boolean> | null = null;

export const refreshSession = async (): Promise<boolean> => {
  if (typeof window === "undefined") return false;
  if (refreshInFlight) return refreshInFlight;

  const refreshToken = localStorage.getItem("ace_refresh_token");
  if (!refreshToken) return false;

  refreshInFlight = (async () => {
    try {
      const res = await fetch(`${API_URL}/api/auth/refresh`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ refreshToken }),
      });
      if (!res.ok) return false;

      const data = await res.json();
      if (!data?.accessToken) return false;

      localStorage.setItem("ace_token", data.accessToken);
      if (data.refreshToken) localStorage.setItem("ace_refresh_token", data.refreshToken);
      if (data.user) localStorage.setItem("ace_user", JSON.stringify(data.user));
      return true;
    } catch {
      return false;
    } finally {
      refreshInFlight = null;
    }
  })();

  return refreshInFlight;
};

const parseError = async (res: Response) => {
  const body = await res.json().catch(() => ({} as any));
  const message = (body as any).message;
  // class-validator returns an array of messages on 400.
  return Array.isArray(message) ? message.join(" ") : message || `Request failed (${res.status})`;
};

const handleResponse = async (res: Response) => {
  if (!res.ok) {
    const msg = await parseError(res);
    if (res.status === 401 && typeof window !== "undefined") {
      clearSession();
      window.location.replace("/login");
    }
    throw new Error(msg);
  }
  return res.json();
};

/**
 * Authenticated fetch that transparently refreshes an expired access token once
 * before giving up and redirecting to /login.
 */
export const authFetch = async (path: string, init: RequestInit = {}) => {
  const send = () => fetch(`${API_URL}${path}`, { ...init, headers: { ...getHeaders(), ...(init.headers || {}) } });

  let res = await send();
  if (res.status === 401 && typeof window !== "undefined") {
    if (await refreshSession()) {
      res = await send();
    }
  }
  return handleResponse(res);
};

export const api = {
  auth: {
    login: async (email?: string, password?: string) => {
      const res = await fetch(`${API_URL}/api/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password }),
      });
      return handleResponse(res);
    },
    register: async (data: any) => {
      const res = await fetch(`${API_URL}/api/auth/register`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
      });
      return handleResponse(res);
    },
    refresh: async (refreshToken: string) => {
      const res = await fetch(`${API_URL}/api/auth/refresh`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ refreshToken }),
      });
      return handleResponse(res);
    },
  },

  crm: {
    getContacts: async () => {
      const res = await fetch(`${API_URL}/api/crm/contacts`, { headers: getHeaders() });
      return handleResponse(res);
    },
    getLeads: async () => {
      const res = await fetch(`${API_URL}/api/crm/leads`, { headers: getHeaders() });
      return handleResponse(res);
    },
    getDeals: async () => {
      const res = await fetch(`${API_URL}/api/crm/deals`, { headers: getHeaders() });
      return handleResponse(res);
    },
    getTickets: async () => {
      const res = await fetch(`${API_URL}/api/crm/tickets`, { headers: getHeaders() });
      return handleResponse(res);
    },
    addContact: async (data: any) => {
      const res = await fetch(`${API_URL}/api/crm/contacts`, {
        method: "POST",
        headers: getHeaders(),
        body: JSON.stringify(data),
      });
      return handleResponse(res);
    },
    addLead: async (data: any) => {
      const res = await fetch(`${API_URL}/api/crm/leads`, {
        method: "POST",
        headers: getHeaders(),
        body: JSON.stringify(data),
      });
      return handleResponse(res);
    },
  },

  conversations: {
    getAll: async () => {
      const res = await fetch(`${API_URL}/api/conversations`, { headers: getHeaders() });
      return handleResponse(res);
    },
    getMessages: async (id: string) => {
      const res = await fetch(`${API_URL}/api/conversations/${id}/messages`, { headers: getHeaders() });
      return handleResponse(res);
    },
    sendMessage: async (id: string, content: string) => {
      // `sender` is not part of the API contract and, with the global
      // ValidationPipe's forbidNonWhitelisted, an unexpected key is a 400.
      const res = await fetch(`${API_URL}/api/conversations/${id}/messages`, {
        method: "POST",
        headers: getHeaders(),
        body: JSON.stringify({ content }),
      });
      return handleResponse(res);
    },
  },

  knowledge: {
    getDocuments: async () => {
      const res = await fetch(`${API_URL}/api/knowledge/documents`, { headers: getHeaders() });
      return handleResponse(res);
    },
    uploadDocument: async (data: any) => {
      const res = await fetch(`${API_URL}/api/knowledge/documents`, {
        method: "POST",
        headers: getHeaders(),
        body: JSON.stringify(data),
      });
      return handleResponse(res);
    },
    search: async (q: string) => {
      const res = await fetch(`${API_URL}/api/knowledge/search?q=${encodeURIComponent(q)}`, {
        headers: getHeaders(),
      });
      return handleResponse(res);
    },
  },

  billing: {
    getSubscription: async () => {
      const res = await fetch(`${API_URL}/api/billing/subscription`, { headers: getHeaders() });
      return handleResponse(res);
    },
    // Route is /api/billing/checkout and it requires a plan. `/initialize-payment`
    // has never existed on the API, and calling it with no body 404'd every time.
    checkout: async (plan: string) => {
      const res = await fetch(`${API_URL}/api/billing/checkout`, {
        method: "POST",
        headers: getHeaders(),
        body: JSON.stringify({ plan }),
      });
      return handleResponse(res);
    },
  },

  telephony: {
    getCallLogs: async () => {
      const res = await fetch(`${API_URL}/api/telephony/calls`, { headers: getHeaders() });
      return handleResponse(res);
    },
    triggerCall: async (toNumber: string, provider?: string) => {
      const res = await fetch(`${API_URL}/api/telephony/outbound`, {
        method: "POST",
        headers: getHeaders(),
        body: JSON.stringify({ toNumber, provider }),
      });
      return handleResponse(res);
    },
  },

  analytics: {
    // Route is /api/analytics/dashboard. `/overview` has never existed on the API.
    getDashboard: async (period: '7d' | '30d' | '90d' = '7d') => {
      const res = await fetch(`${API_URL}/api/analytics/dashboard?period=${period}`, {
        headers: getHeaders(),
      });
      return handleResponse(res);
    },
  },

  organizations: {
    getMe: async () => {
      const res = await fetch(`${API_URL}/api/organizations/me`, { headers: getHeaders() });
      return handleResponse(res);
    },
    updateSettings: async (data: any) => {
      const res = await fetch(`${API_URL}/api/organizations/settings`, {
        method: "PATCH",
        headers: getHeaders(),
        body: JSON.stringify(data),
      });
      return handleResponse(res);
    },
    updateWhatsAppConfig: async (data: any) => {
      const res = await fetch(`${API_URL}/api/organizations/whatsapp-config`, {
        method: "POST",
        headers: getHeaders(),
        body: JSON.stringify(data),
      });
      return handleResponse(res);
    },
    updateTelephonyConfig: async (data: any) => {
      const res = await fetch(`${API_URL}/api/organizations/telephony-config`, {
        method: "POST",
        headers: getHeaders(),
        body: JSON.stringify(data),
      });
      return handleResponse(res);
    },
    addTeamMember: async (data: any) => {
      const res = await fetch(`${API_URL}/api/organizations/members`, {
        method: "POST",
        headers: getHeaders(),
        body: JSON.stringify(data),
      });
      return handleResponse(res);
    },
    getTeamMembers: async () => {
      const res = await fetch(`${API_URL}/api/organizations/members`, { headers: getHeaders() });
      return handleResponse(res);
    },
    updateMemberRole: async (userId: string, role: string) => {
      const res = await fetch(`${API_URL}/api/organizations/members/${userId}/role`, {
        method: "PATCH",
        headers: getHeaders(),
        body: JSON.stringify({ role }),
      });
      return handleResponse(res);
    },
    updateMemberStatus: async (userId: string, isActive: boolean) => {
      const res = await fetch(`${API_URL}/api/organizations/members/${userId}/status`, {
        method: "PATCH",
        headers: getHeaders(),
        body: JSON.stringify({ isActive }),
      });
      return handleResponse(res);
    },
    removeTeamMember: async (userId: string) => {
      const res = await fetch(`${API_URL}/api/organizations/members/${userId}`, {
        method: "DELETE",
        headers: getHeaders(),
      });
      return handleResponse(res);
    },
    /** Returns { apiKey } — the plaintext key, shown once and never retrievable again. */
    regenerateApiKey: async () => {
      const res = await fetch(`${API_URL}/api/organizations/api-keys/regenerate`, {
        method: "POST",
        headers: getHeaders(),
      });
      return handleResponse(res);
    },
    getPermissionsMatrix: async () => {
      const res = await fetch(`${API_URL}/api/organizations/roles/permissions`, { headers: getHeaders() });
      return handleResponse(res);
    },
  },

  /**
   * The tenant's own ElevenLabs workspace.
   *
   * An ElevenLabs workspace has no tenancy of its own — everything in one
   * belongs to whoever holds the key — so each tenant needs its own, and until
   * it has one every hosted-agent operation is refused. These two endpoints are
   * how that gets configured; before this there was no way short of SQL, and a
   * credential nobody can rotate without a database console does not get
   * rotated.
   */
  agentProvisioning: {
    /**
     * Reports `mode`, a fingerprint, `webhookUrl` and `warnings[]`. Never
     * returns a credential — there is no read-back endpoint at all, by design.
     */
    getCredentials: async () => {
      const res = await fetch(`${API_URL}/api/agent-provisioning/credentials`, { headers: getHeaders() });
      return handleResponse(res);
    },
    /**
     * Either half, or both. A dedicated workspace needs each: the key to act in
     * it, and its own webhook signing secret to verify what it sends back.
     * Returns the full status, so a caller that set one half is told
     * immediately that the other is still missing.
     */
    setCredentials: async (data: { apiKey?: string; webhookSecret?: string }) => {
      const res = await fetch(`${API_URL}/api/agent-provisioning/credentials`, {
        method: 'POST',
        headers: getHeaders(),
        body: JSON.stringify(data),
      });
      return handleResponse(res);
    },
    /** Read-only comparison of the remote agent against this repo. Writes nothing. */
    getStatus: async () => {
      const res = await fetch(`${API_URL}/api/agent-provisioning/status`, { headers: getHeaders() });
      return handleResponse(res);
    },
  },

};
