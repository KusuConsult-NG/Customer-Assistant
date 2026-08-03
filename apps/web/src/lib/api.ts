export const API_URL = process.env.NEXT_PUBLIC_API_URL || "http://localhost:4000";

const getHeaders = () => {
  const token = typeof window !== "undefined" ? localStorage.getItem("ace_token") : null;
  return {
    "Content-Type": "application/json",
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
};

const handleResponse = async (res: Response) => {
  if (res.status === 401 && typeof window !== "undefined") {
    localStorage.removeItem("ace_token");
    localStorage.removeItem("ace_user");
    window.location.href = "/login";
  }
  if (!res.ok) {
    const error = await res.json().catch(() => ({}));
    throw new Error((error as any).message || "An error occurred");
  }
  return res.json();
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
      const res = await fetch(`${API_URL}/api/conversations/${id}/messages`, {
        method: "POST",
        headers: getHeaders(),
        body: JSON.stringify({ content, sender: "human" }),
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
    initializePayment: async () => {
      const res = await fetch(`${API_URL}/api/billing/initialize-payment`, {
        method: "POST",
        headers: getHeaders(),
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
    getOverview: async () => {
      const res = await fetch(`${API_URL}/api/analytics/overview`, { headers: getHeaders() });
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
  },

  widget: {
    getConfig: async (apiKey: string, orgId?: string) => {
      const qs = apiKey ? `apiKey=${apiKey}` : `orgId=${orgId || ''}`;
      const res = await fetch(`${API_URL}/api/widget/config?${qs}`);
      return handleResponse(res);
    },
    sendChatMessage: async (data: { apiKey?: string; orgId?: string; sessionId: string; message: string; customerName?: string; customerEmail?: string; customerPhone?: string }) => {
      const res = await fetch(`${API_URL}/api/widget/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
      });
      return handleResponse(res);
    },
    getHistory: async (apiKey: string, sessionId: string) => {
      const res = await fetch(`${API_URL}/api/widget/history?apiKey=${apiKey}&sessionId=${sessionId}`);
      return handleResponse(res);
    },
  },
};
