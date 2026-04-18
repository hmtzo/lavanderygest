// Autentique GraphQL client (Node 20+ native fetch/FormData/Blob)
const API_URL = () => process.env.AUTENTIQUE_API_URL || 'https://api.autentique.com.br/v2/graphql';
const TOKEN = () => process.env.AUTENTIQUE_API_TOKEN;

const CREATE_DOC_MUTATION = `
  mutation CreateDocument($document: DocumentInput!, $signers: [SignerInput!]!, $file: Upload!) {
    createDocument(document: $document, signers: $signers, file: $file) {
      id
      name
      refusable
      sortable
      created_at
      signatures {
        public_id
        name
        email
        created_at
        action { name }
        link { short_link }
        user { id name email }
      }
    }
  }
`;

export async function sendDocumentForSignature({ name, pdfBuffer, signers }) {
  if (!TOKEN()) throw new Error('AUTENTIQUE_API_TOKEN not configured');

  const operations = {
    query: CREATE_DOC_MUTATION,
    variables: {
      document: { name },
      signers: signers.map(s => ({ email: s.email, name: s.name, action: 'SIGN' })),
      file: null,
    },
  };
  const map = { '0': ['variables.file'] };

  const form = new FormData();
  form.append('operations', JSON.stringify(operations));
  form.append('map', JSON.stringify(map));
  const blob = new Blob([pdfBuffer], { type: 'application/pdf' });
  form.append('0', blob, `${name}.pdf`);

  const r = await fetch(API_URL(), {
    method: 'POST',
    headers: { Authorization: `Bearer ${TOKEN()}` },
    body: form,
  });
  const json = await r.json();
  if (json.errors) throw new Error(json.errors.map(e=>e.message).join('; '));
  return json.data.createDocument;
}

export async function listDocuments({ limit = 60, page = 1, context = 'ORGANIZATION' } = {}) {
  const q = `query($limit: Int!, $page: Int!, $context: ContextEnum) {
    documents(limit: $limit, page: $page, context: $context) {
      total current_page last_page
      data {
        id name created_at
        files { original signed }
        signatures { public_id name email action { name } signed { created_at } }
      }
    }
  }`;
  const r = await fetch(API_URL(), {
    method: 'POST',
    headers: { 'Content-Type':'application/json', Authorization: `Bearer ${TOKEN()}` },
    body: JSON.stringify({ query: q, variables: { limit, page, context } }),
  });
  const json = await r.json();
  if (json.errors) throw new Error(json.errors.map(e=>e.message).join('; '));
  return json.data.documents;
}

// Fetch every page
export async function listAllDocuments({ context = 'ORGANIZATION', pageSize = 60 } = {}) {
  const first = await listDocuments({ limit: pageSize, page: 1, context });
  let all = [...first.data];
  for (let p = 2; p <= first.last_page; p++) {
    const r = await listDocuments({ limit: pageSize, page: p, context });
    all = all.concat(r.data);
  }
  return { total: first.total, last_page: first.last_page, data: all };
}

export async function downloadFile(url) {
  // Only send Bearer token when hitting Autentique's own domain.
  // External (e.g. Google Cloud Storage signed URLs) reject or ignore auth.
  const isAutentique = /(^https?:\/\/)?(api\.)?autentique\.com\.br/i.test(url);
  const headers = isAutentique ? { Authorization: `Bearer ${TOKEN()}` } : {};
  const r = await fetch(url, { headers });
  if (!r.ok) throw new Error(`download_failed_${r.status}`);
  const ab = await r.arrayBuffer();
  return Buffer.from(ab);
}

export async function getDocument(id) {
  const q = `query($id: UUID!){ document(id: $id) { id name created_at signatures { public_id name email action{ name } created_at viewed{ created_at } signed{ created_at } link{ short_link } } } }`;
  const r = await fetch(API_URL(), {
    method: 'POST',
    headers: { 'Content-Type':'application/json', Authorization: `Bearer ${TOKEN()}` },
    body: JSON.stringify({ query: q, variables: { id } }),
  });
  const json = await r.json();
  if (json.errors) throw new Error(json.errors.map(e=>e.message).join('; '));
  return json.data.document;
}
