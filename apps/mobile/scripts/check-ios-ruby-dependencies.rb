# frozen_string_literal: true

# Run with the iOS Gemfile: bundle exec ruby scripts/check-ios-ruby-dependencies.rb
require 'active_support'
require 'active_support/core_ext/string/output_safety'
require 'active_support/number_helper'
require 'concurrent/atomic/atomic_reference'
require 'concurrent/version'
require 'timeout'

def check(message)
  raise message unless yield
  puts "PASS: #{message}"
end

puts "Ruby #{RUBY_VERSION}; ActiveSupport #{ActiveSupport::VERSION::STRING}; concurrent-ruby #{Concurrent::VERSION}"

# GHSA-h8w8-99g7-qmvj: a NaN reference must update instead of retrying forever.
reference = Concurrent::AtomicReference.new(Float::NAN)
worker = Thread.new { reference.update { 42.0 } }
begin
  check('AtomicReference updates a NaN value within the deadline') { worker.join(5) }
  check('AtomicReference stores the replacement value') { worker.value == 42.0 && reference.get == 42.0 }
ensure
  worker.kill if worker.alive?
  worker.join
end

# GHSA-89vf-4333-qx8v: formatting must preserve the unsafe flag after mutation.
buffer = ActiveSupport::SafeBuffer.new('%{value}')
buffer.gsub!('%{value}', '<%{value}>')
check('SafeBuffer mutation marks the buffer unsafe') { !buffer.html_safe? }
formatted = buffer % { value: '<script>alert(1)</script>' }
check('SafeBuffer formatting preserves the unsafe flag') { !formatted.html_safe? }

# GHSA-2j26-frm8-cmj9: exponent strings must not expand to enormous decimals.
Timeout.timeout(5) do
  check('Number helpers retain exponent input without expanding it') do
    ActiveSupport::NumberHelper.number_to_currency('1e10000') == '$1e10000'
  end
end

# Exercise long-number formatting with a deadline and exact content validation.
# This bounded smoke check does not prove asymptotic complexity on every Ruby VM.
digits = '123' * 10_000
Timeout.timeout(5) do
  check('Number delimiter helper formats a long digit string correctly') do
    ActiveSupport::NumberHelper.number_to_delimited(digits) == (['123'] * 10_000).join(',')
  end
end
