/* Shop module app logic. One screen: a jobs list (Estimate/In Progress/Complete)
   plus a single estimate form that captures customer + bike + job together and
   calls shop_submit_estimate once — per Tyler, staff never re-enter the same
   customer/bike info on a separate page. */
(function (root) {
  'use strict';
  const $ = id => document.getElementById(id);
  const genId = () => (crypto.randomUUID ? crypto.randomUUID().replace(/-/g, '').slice(0, 12) : String(Date.now()));

  const App = {
    jobs: [], customers: [], bikes: [], editingJobId: null,

    async init() {
      try {
        await ShApi.verify();
      } catch {
        location.href = '../auth.html?next=shop/';
        return;
      }
      await this.refresh();
      $('shEstimateForm').addEventListener('submit', e => { e.preventDefault(); this.submitEstimate(); });
      $('shNewJobBtn').addEventListener('click', () => this.openForm(null));
      $('shCustomerPick').addEventListener('change', () => this.fillCustomerFields());
    },

    async refresh() {
      const [jobs, customers, bikes] = await Promise.all([
        ShApi.select('shop_jobs', 'select=*,shop_customers(name),shop_bikes(make,model,vin)&order=job_date.desc'),
        ShApi.select('shop_customers', 'select=id,name,phone,email,address&order=name'),
        ShApi.select('shop_bikes', 'select=id,customer_id,vin,make,model,year,mileage'),
      ]);
      this.jobs = jobs; this.customers = customers; this.bikes = bikes;
      this.renderJobs(); this.renderCustomerOptions();
    },

    renderJobs() {
      const box = $('shJobsList'); box.innerHTML = '';
      for (const j of this.jobs) {
        const row = document.createElement('div');
        row.className = 'sh-job-row sh-status-' + j.status;
        row.innerHTML = `
          <span class="sh-job-invoice">${j.invoice_number || '(no #)'}</span>
          <span class="sh-job-customer">${j.shop_customers?.name || ''}</span>
          <span class="sh-job-bike">${[j.shop_bikes?.make, j.shop_bikes?.model].filter(Boolean).join(' ') || ''}</span>
          <span class="sh-job-status">${j.status.replace('_', ' ')}</span>
          <span class="sh-job-total">$${Number(j.total_amount).toFixed(2)}</span>
          <button type="button" data-edit="${j.id}">Edit</button>
          <button type="button" data-advance="${j.id}">${this.nextStatusLabel(j.status)}</button>`;
        box.appendChild(row);
      }
      box.querySelectorAll('[data-edit]').forEach(b => b.addEventListener('click', () => this.openForm(b.dataset.edit)));
      box.querySelectorAll('[data-advance]').forEach(b => b.addEventListener('click', () => this.advanceStatus(b.dataset.advance)));
    },

    nextStatusLabel(status) {
      return status === 'estimate' ? 'Start job' : status === 'in_progress' ? 'Mark complete' : 'Done';
    },
    nextStatus(status) {
      return status === 'estimate' ? 'in_progress' : status === 'in_progress' ? 'complete' : 'complete';
    },

    async advanceStatus(jobId) {
      const job = this.jobs.find(j => j.id === jobId);
      if (!job || job.status === 'complete') return;
      await ShApi.rpc('shop_submit_estimate', {
        p_job_id: job.id, p_customer_id: job.customer_id, p_customer: null,
        p_bike_id: job.bike_id, p_bike: null,
        p_job: { status: this.nextStatus(job.status) },
      });
      await this.refresh();
    },

    renderCustomerOptions() {
      const sel = $('shCustomerPick');
      sel.innerHTML = '<option value="">New customer…</option>' +
        this.customers.map(c => `<option value="${c.id}">${c.name}</option>`).join('');
    },

    fillCustomerFields() {
      const id = $('shCustomerPick').value;
      const c = this.customers.find(x => x.id === id);
      $('shName').value = c?.name || ''; $('shPhone').value = c?.phone || '';
      $('shEmail').value = c?.email || ''; $('shAddress').value = c?.address || '';
      const bikeSel = $('shBikePick');
      const bikes = this.bikes.filter(b => b.customer_id === id);
      bikeSel.innerHTML = '<option value="">New bike…</option>' +
        bikes.map(b => `<option value="${b.id}">${[b.year, b.make, b.model].filter(Boolean).join(' ')} — ${b.vin || 'no VIN'}</option>`).join('');
    },

    openForm(jobId) {
      this.editingJobId = jobId;
      this.pendingPhotoFiles = [];
      this.existingPhotoUrls = [];
      $('shEstimateForm').reset();
      $('shBikePick').innerHTML = '<option value="">New bike…</option>';
      $('shPhotoPreview').innerHTML = '';
      if (jobId) {
        const j = this.jobs.find(x => x.id === jobId);
        $('shCustomerPick').value = j.customer_id || ''; this.fillCustomerFields();
        if (j.bike_id) {
          $('shBikePick').value = j.bike_id;
          const bike = this.bikes.find(b => b.id === j.bike_id);
          this.existingPhotoUrls = bike?.photo_urls || [];
          this.renderPhotoPreview();
        }
        $('shInvoiceNumber').value = j.invoice_number || '';
        $('shPartsAmount').value = j.parts_amount; $('shLaborAmount').value = j.labor_amount;
        $('shTaxAmount').value = j.tax_amount; $('shTotalAmount').value = j.total_amount;
        $('shPartsCost').value = j.parts_cost; $('shNotes').value = j.notes || '';
      }
      $('shFormTitle').textContent = jobId ? 'Edit job' : 'New estimate';
      $('shFormDialog').showModal ? $('shFormDialog').showModal() : ($('shFormDialog').hidden = false);
    },

    renderPhotoPreview() {
      $('shPhotoPreview').innerHTML = this.existingPhotoUrls
        .map(url => `<img src="${url}" alt="bike photo">`).join('');
    },

    // Uploads any newly selected files to the shop-bike-photos bucket and
    // returns the full list of photo URLs (existing + newly uploaded) to save
    // on the bike record. Runs after the bike id is known (new or existing).
    async uploadPendingPhotos(bikeId) {
      const files = $('shPhotoFiles').files;
      const urls = [...this.existingPhotoUrls];
      for (const file of files) {
        const path = `${bikeId}/${Date.now()}-${file.name}`;
        await ShApi.upload('shop-bike-photos', path, file);
        urls.push(ShApi.publicUrl('shop-bike-photos', path));
      }
      return urls;
    },

    async submitEstimate() {
      const customerId = $('shCustomerPick').value || null;
      const bikeId = $('shBikePick').value || null;
      const [result] = await ShApi.rpc('shop_submit_estimate', {
        p_job_id: this.editingJobId, p_customer_id: customerId,
        p_customer: { name: $('shName').value, phone: $('shPhone').value, email: $('shEmail').value, address: $('shAddress').value },
        p_bike_id: bikeId,
        p_bike: { vin: $('shVin').value, make: $('shMake').value, model: $('shModel').value, year: $('shYear').value, mileage: $('shMileage').value },
        p_job: {
          invoice_number: $('shInvoiceNumber').value || null,
          parts_amount: $('shPartsAmount').value || 0, labor_amount: $('shLaborAmount').value || 0,
          tax_amount: $('shTaxAmount').value || 0, total_amount: $('shTotalAmount').value || 0,
          parts_cost: $('shPartsCost').value || 0, notes: $('shNotes').value || null,
        },
      });
      if (result?.bike_id && $('shPhotoFiles').files.length) {
        const urls = await this.uploadPendingPhotos(result.bike_id);
        await ShApi.rpc('shop_set_bike_photos', { p_bike_id: result.bike_id, p_photo_urls: urls });
      }
      $('shFormDialog').close ? $('shFormDialog').close() : ($('shFormDialog').hidden = true);
      await this.refresh();
    },
  };
  root.App = App;
  document.addEventListener('DOMContentLoaded', () => App.init());
})(typeof window !== 'undefined' ? window : globalThis);
